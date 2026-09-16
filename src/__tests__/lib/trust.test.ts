import { describe, expect, it } from 'vitest';
import type { Account, AccountRole } from '@/lib/auth/store';
import {
  accountTrust,
  buildTrustChain,
  isChainAccount,
  isProjectedTrustEdge,
  isStaffRole,
  pendingModeratorProposals,
  serializeTrustEdge,
  type TrustEdge,
} from '@/lib/trust';

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

function edge(
  partial: Pick<TrustEdge, 'id' | 'subjectId' | 'actorId' | 'kind'> & Partial<TrustEdge>,
): TrustEdge {
  return { createdAt: 1, ...partial };
}

describe('isStaffRole', () => {
  it('is true for founder and moderator only', () => {
    const roles: AccountRole[] = ['basis', 'verified', 'moderator', 'founder'];
    expect(roles.filter(isStaffRole)).toEqual(['moderator', 'founder']);
  });
});

describe('isChainAccount', () => {
  it('is true for founder, moderator, and verified only', () => {
    const roles: AccountRole[] = ['basis', 'verified', 'moderator', 'founder'];
    expect(roles.filter((role) => isChainAccount(account({ id: role, role })))).toEqual([
      'verified',
      'moderator',
      'founder',
    ]);
  });
});

describe('isProjectedTrustEdge', () => {
  it('projects verify when the subject is undefined', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'v', actorId: 'm', kind: 'verify' }),
        undefined,
      ),
    ).toBe(true);
  });

  it('projects moderator_appoint', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'm', actorId: 'f', kind: 'moderator_appoint' }),
        account({ id: 'm', role: 'moderator' }),
      ),
    ).toBe(true);
  });

  it('projects moderator_propose when the subject is a moderator', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'm', actorId: 'p', kind: 'moderator_propose' }),
        account({ id: 'm', role: 'moderator' }),
      ),
    ).toBe(true);
  });

  it('omits moderator_propose when the subject is verified', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'v', actorId: 'm', kind: 'moderator_propose' }),
        account({ id: 'v', role: 'verified' }),
      ),
    ).toBe(false);
  });

  it('omits moderator_propose when the subject is undefined', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'm', actorId: 'p', kind: 'moderator_propose' }),
        undefined,
      ),
    ).toBe(false);
  });

  it('omits moderator_confirm even when the subject is a moderator', () => {
    expect(
      isProjectedTrustEdge(
        edge({ id: 'e', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm' }),
        account({ id: 'm', role: 'moderator' }),
      ),
    ).toBe(false);
  });
});

describe('buildTrustChain', () => {
  it('returns empty arrays when there are no staff or verified accounts', () => {
    expect(buildTrustChain([account({ id: 'b', role: 'basis' })], [])).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it('sorts founder, then moderator, then verified; oldest createdAt then id', () => {
    const verifiedLate = account({ id: 'v2', role: 'verified', createdAt: 3, name: 'V2' });
    const verifiedEarly = account({ id: 'v1', role: 'verified', createdAt: 2, name: 'V1' });
    const verifiedTieHigh = account({ id: 'v9', role: 'verified', createdAt: 2, name: 'V9' });
    const moderator = account({ id: 'm', role: 'moderator', createdAt: 9, name: 'Mod' });
    const founderLate = account({ id: 'f2', role: 'founder', createdAt: 8, name: 'F2' });
    const founderEarly = account({ id: 'f1', role: 'founder', createdAt: 1, name: 'F1' });
    const basis = account({
      id: 'b',
      role: 'basis',
      createdAt: 0,
      name: 'Basis',
      lightningAddress: 'b@walletofsatoshi.com',
      viewKey: 'b'.repeat(64),
      linkingKey: 'aa'.repeat(32),
    });
    const chain = buildTrustChain(
      [verifiedLate, verifiedTieHigh, verifiedEarly, moderator, founderLate, founderEarly, basis],
      [],
    );
    expect(chain.nodes.map((node) => node.id)).toEqual(['f1', 'f2', 'm', 'v1', 'v9', 'v2']);
    expect(chain.nodes[0]).toEqual({ id: 'f1', name: 'F1', role: 'founder' });
    expect(chain.nodes[0]).not.toHaveProperty('lightningAddress');
    expect(chain.nodes[0]).not.toHaveProperty('viewKey');
    expect(chain.nodes[0]).not.toHaveProperty('linkingKey');
    const early = account({ id: 'va', role: 'verified', createdAt: 2 });
    const lateId = account({ id: 'vz', role: 'verified', createdAt: 2 });
    expect(buildTrustChain([lateId, early], []).nodes.map((node) => node.id)).toEqual(['va', 'vz']);
    expect(buildTrustChain([early, lateId], []).nodes.map((node) => node.id)).toEqual(['va', 'vz']);
    expect(chain.edges).toEqual([]);
  });

  it('keeps equal role, createdAt, and id as a sort tie', () => {
    const one = account({ id: 'same', role: 'founder', createdAt: 1, name: 'A' });
    const dup = account({ id: 'same', role: 'founder', createdAt: 1, name: 'B' });
    const chain = buildTrustChain([one, dup], []);
    expect(chain.nodes.map((node) => node.id)).toEqual(['same', 'same']);
  });

  it('projects stored public edges, omits confirm, and shows propose only for moderators', () => {
    const founder = account({ id: 'f', role: 'founder', name: 'F' });
    const proposer = account({ id: 'p', role: 'moderator', name: 'P', createdAt: 2 });
    const moderator = account({ id: 'm', role: 'moderator', name: 'M', createdAt: 3 });
    const verified = account({ id: 'v', role: 'verified', name: 'V' });
    const basis = account({ id: 'b', role: 'basis', name: 'B' });
    const disconnected = account({ id: 'd', role: 'verified', name: 'D' });
    const edges: TrustEdge[] = [
      edge({ id: 'e-verify', subjectId: 'v', actorId: 'm', kind: 'verify' }),
      edge({ id: 'e-pending', subjectId: 'v', actorId: 'm', kind: 'moderator_propose' }),
      edge({ id: 'e-propose', subjectId: 'm', actorId: 'p', kind: 'moderator_propose' }),
      edge({ id: 'e-confirm', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm' }),
      edge({ id: 'e-appoint', subjectId: 'm', actorId: 'f', kind: 'moderator_appoint' }),
      edge({ id: 'e-basis-actor', subjectId: 'v', actorId: 'b', kind: 'verify' }),
      edge({ id: 'e-basis-subject', subjectId: 'b', actorId: 'f', kind: 'verify' }),
    ];
    const chain = buildTrustChain(
      [founder, proposer, moderator, verified, basis, disconnected],
      edges,
    );
    expect(chain.nodes.map((node) => node.id)).toEqual(['f', 'p', 'm', 'd', 'v']);
    expect(chain.edges).toEqual([
      { from: 'm', to: 'v', kind: 'verify' },
      { from: 'p', to: 'm', kind: 'moderator_propose' },
      { from: 'f', to: 'm', kind: 'moderator_appoint' },
    ]);
    expect(chain.edges.map((item) => item.kind)).not.toContain('moderator_confirm');
    expect(chain.edges.some((item) => item.to === 'd')).toBe(false);
  });
});

describe('accountTrust', () => {
  it('returns all-null when the subject has no edges', () => {
    expect(accountTrust('s', [account({ id: 's', role: 'basis' })], [])).toEqual({
      verifiedBy: null,
      proposedBy: null,
      confirmedBy: null,
      appointedBy: null,
    });
  });

  it('picks the latest edge of each kind by createdAt then id, with live actor names', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Sub' });
    const ada = account({ id: 'ada', role: 'moderator', name: 'Ada' });
    const bob = account({ id: 'bob', role: 'founder', name: 'Bob' });
    const unnamed = account({ id: 'u', role: 'moderator', name: null });
    const edges: TrustEdge[] = [
      edge({ id: 'v-old', subjectId: 's', actorId: 'ada', kind: 'verify', createdAt: 1 }),
      edge({ id: 'v-new', subjectId: 's', actorId: 'bob', kind: 'verify', createdAt: 2 }),
      edge({ id: 'p-a', subjectId: 's', actorId: 'ada', kind: 'moderator_propose', createdAt: 5 }),
      edge({ id: 'p-b', subjectId: 's', actorId: 'bob', kind: 'moderator_propose', createdAt: 5 }),
      edge({ id: 'c1', subjectId: 's', actorId: 'u', kind: 'moderator_confirm', createdAt: 3 }),
      edge({
        id: 'a1',
        subjectId: 's',
        actorId: 'missing',
        kind: 'moderator_appoint',
        createdAt: 4,
      }),
      edge({ id: 'other', subjectId: 'x', actorId: 'ada', kind: 'verify', createdAt: 9 }),
    ];
    expect(accountTrust('s', [subject, ada, bob, unnamed], edges)).toEqual({
      verifiedBy: { id: 'bob', name: 'Bob' },
      proposedBy: { id: 'bob', name: 'Bob' },
      confirmedBy: { id: 'u', name: null },
      appointedBy: { id: 'missing', name: null },
    });
  });
});

describe('pendingModeratorProposals', () => {
  it('returns an empty list when there are no edges', () => {
    expect(pendingModeratorProposals([account({ id: 's', role: 'verified' })], [])).toEqual([]);
  });

  it('returns one row with live names for a propose on a verified subject', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Ada' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({ id: 'v1', subjectId: 's', actorId: 'm', kind: 'verify', createdAt: 1 }),
      edge({
        id: 'p1',
        subjectId: 's',
        actorId: 'm',
        kind: 'moderator_propose',
        createdAt: 10,
      }),
    ];
    expect(pendingModeratorProposals([subject, actor], edges)).toEqual([
      {
        subject: { id: 's', name: 'Ada', role: 'verified' },
        proposedBy: { id: 'm', name: 'Mod' },
        createdAt: 10,
      },
    ]);
  });

  it('sets subject.name to null when the verified subject name is null', () => {
    const subject = account({ id: 's', role: 'verified', name: null });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const propose = edge({
      id: 'p1',
      subjectId: 's',
      actorId: 'm',
      kind: 'moderator_propose',
      createdAt: 10,
    });
    expect(pendingModeratorProposals([subject, actor], [propose])).toEqual([
      {
        subject: { id: 's', name: null, role: 'verified' },
        proposedBy: { id: 'm', name: 'Mod' },
        createdAt: 10,
      },
    ]);
  });

  it('omits a propose whose subject is still basis', () => {
    const subject = account({ id: 's', role: 'basis', name: 'Ada' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const propose = edge({ id: 'p1', subjectId: 's', actorId: 'm', kind: 'moderator_propose' });
    expect(pendingModeratorProposals([subject, actor], [propose])).toEqual([]);
  });

  it('omits a propose when the subject also has a confirm edge', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Ada' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({ id: 'p1', subjectId: 's', actorId: 'm', kind: 'moderator_propose' }),
      edge({ id: 'c1', subjectId: 's', actorId: 'f', kind: 'moderator_confirm' }),
    ];
    expect(pendingModeratorProposals([subject, actor], edges)).toEqual([]);
  });

  it('omits a propose when the subject also has an appoint edge', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Ada' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({ id: 'p1', subjectId: 's', actorId: 'm', kind: 'moderator_propose' }),
      edge({ id: 'a1', subjectId: 's', actorId: 'f', kind: 'moderator_appoint' }),
    ];
    expect(pendingModeratorProposals([subject, actor], edges)).toEqual([]);
  });

  it('omits a propose when the subject account is missing', () => {
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const propose = edge({ id: 'p1', subjectId: 's', actorId: 'm', kind: 'moderator_propose' });
    expect(pendingModeratorProposals([actor], [propose])).toEqual([]);
  });

  it('sets proposedBy.name to null when the actor account is missing', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Ada' });
    const propose = edge({
      id: 'p1',
      subjectId: 's',
      actorId: 'missing',
      kind: 'moderator_propose',
      createdAt: 4,
    });
    expect(pendingModeratorProposals([subject], [propose])).toEqual([
      {
        subject: { id: 's', name: 'Ada', role: 'verified' },
        proposedBy: { id: 'missing', name: null },
        createdAt: 4,
      },
    ]);
  });

  it('sorts two pending proposes oldest createdAt first', () => {
    const early = account({ id: 's1', role: 'verified', name: 'Ada' });
    const late = account({ id: 's2', role: 'verified', name: 'Bob' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({
        id: 'p-late',
        subjectId: 's2',
        actorId: 'm',
        kind: 'moderator_propose',
        createdAt: 20,
      }),
      edge({
        id: 'p-early',
        subjectId: 's1',
        actorId: 'm',
        kind: 'moderator_propose',
        createdAt: 10,
      }),
    ];
    expect(
      pendingModeratorProposals([late, early, actor], edges).map((row) => row.subject.id),
    ).toEqual(['s1', 's2']);
  });

  it('omits founder and moderator subjects that still have a stale propose', () => {
    const founder = account({ id: 'f', role: 'founder', name: 'F' });
    const moderator = account({ id: 'm', role: 'moderator', name: 'M' });
    const actor = account({ id: 'a', role: 'founder', name: 'Actor' });
    const edges: TrustEdge[] = [
      edge({ id: 'pf', subjectId: 'f', actorId: 'a', kind: 'moderator_propose' }),
      edge({ id: 'pm', subjectId: 'm', actorId: 'a', kind: 'moderator_propose' }),
    ];
    expect(pendingModeratorProposals([founder, moderator, actor], edges)).toEqual([]);
  });

  it('keeps the latest propose per subject by createdAt then id', () => {
    const subject = account({ id: 's', role: 'verified', name: 'Ada' });
    const ada = account({ id: 'ada', role: 'moderator', name: 'Ada Mod' });
    const bob = account({ id: 'bob', role: 'founder', name: 'Bob' });
    const edges: TrustEdge[] = [
      edge({
        id: 'p-old',
        subjectId: 's',
        actorId: 'ada',
        kind: 'moderator_propose',
        createdAt: 1,
      }),
      edge({
        id: 'p-a',
        subjectId: 's',
        actorId: 'ada',
        kind: 'moderator_propose',
        createdAt: 2,
      }),
      edge({
        id: 'p-new',
        subjectId: 's',
        actorId: 'bob',
        kind: 'moderator_propose',
        createdAt: 2,
      }),
      edge({
        id: 'p-aaa',
        subjectId: 's',
        actorId: 'ada',
        kind: 'moderator_propose',
        createdAt: 2,
      }),
    ];
    expect(pendingModeratorProposals([subject, ada, bob], edges)).toEqual([
      {
        subject: { id: 's', name: 'Ada', role: 'verified' },
        proposedBy: { id: 'bob', name: 'Bob' },
        createdAt: 2,
      },
    ]);
  });

  it('sorts equal createdAt by propose-edge id', () => {
    const first = account({ id: 's1', role: 'verified', name: 'Ada' });
    const second = account({ id: 's2', role: 'verified', name: 'Bob' });
    const third = account({ id: 's3', role: 'verified', name: 'Cam' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({ id: 'p-z', subjectId: 's2', actorId: 'm', kind: 'moderator_propose', createdAt: 5 }),
      edge({ id: 'p-a', subjectId: 's1', actorId: 'm', kind: 'moderator_propose', createdAt: 5 }),
      edge({ id: 'p-m', subjectId: 's3', actorId: 'm', kind: 'moderator_propose', createdAt: 5 }),
    ];
    expect(
      pendingModeratorProposals([second, first, third, actor], edges).map(
        (row) => row.subject.id,
      ),
    ).toEqual(['s1', 's3', 's2']);
  });

  it('keeps equal createdAt and id as a sort tie', () => {
    const one = account({ id: 's1', role: 'verified', name: 'A' });
    const two = account({ id: 's2', role: 'verified', name: 'B' });
    const actor = account({ id: 'm', role: 'moderator', name: 'Mod' });
    const edges: TrustEdge[] = [
      edge({ id: 'same', subjectId: 's1', actorId: 'm', kind: 'moderator_propose', createdAt: 5 }),
      edge({ id: 'same', subjectId: 's2', actorId: 'm', kind: 'moderator_propose', createdAt: 5 }),
    ];
    expect(
      pendingModeratorProposals([one, two, actor], edges).map((row) => row.subject.id),
    ).toEqual(['s1', 's2']);
  });
});

describe('serializeTrustEdge', () => {
  it('emits ISO createdAt and the stored fields', () => {
    expect(
      serializeTrustEdge(
        edge({
          id: 'e1',
          subjectId: 's',
          actorId: 'a',
          kind: 'verify',
          createdAt: Date.parse('2026-09-12T00:00:00.000Z'),
        }),
      ),
    ).toEqual({
      id: 'e1',
      subjectId: 's',
      actorId: 'a',
      kind: 'verify',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
  });
});
