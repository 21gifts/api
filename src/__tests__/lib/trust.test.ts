import { describe, expect, it } from 'vitest';
import type { Account, AccountRole } from '@/lib/auth/store';
import {
  accountTrust,
  buildTrustChain,
  isStaffRole,
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
    expect(chain.edges).toEqual([]);
  });

  it('keeps equal role, createdAt, and id as a sort tie', () => {
    const one = account({ id: 'same', role: 'founder', createdAt: 1, name: 'A' });
    const dup = account({ id: 'same', role: 'founder', createdAt: 1, name: 'B' });
    const chain = buildTrustChain([one, dup], []);
    expect(chain.nodes.map((node) => node.id)).toEqual(['same', 'same']);
  });

  it('projects stored public edges and never invents or includes propose', () => {
    const founder = account({ id: 'f', role: 'founder', name: 'F' });
    const moderator = account({ id: 'm', role: 'moderator', name: 'M' });
    const verified = account({ id: 'v', role: 'verified', name: 'V' });
    const basis = account({ id: 'b', role: 'basis', name: 'B' });
    const disconnected = account({ id: 'd', role: 'verified', name: 'D' });
    const edges: TrustEdge[] = [
      edge({ id: 'e-verify', subjectId: 'v', actorId: 'm', kind: 'verify' }),
      edge({ id: 'e-propose', subjectId: 'v', actorId: 'm', kind: 'moderator_propose' }),
      edge({ id: 'e-confirm', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm' }),
      edge({ id: 'e-appoint', subjectId: 'm', actorId: 'f', kind: 'moderator_appoint' }),
      edge({ id: 'e-basis-actor', subjectId: 'v', actorId: 'b', kind: 'verify' }),
      edge({ id: 'e-basis-subject', subjectId: 'b', actorId: 'f', kind: 'verify' }),
    ];
    const chain = buildTrustChain(
      [founder, moderator, verified, basis, disconnected],
      edges,
    );
    expect(chain.nodes.map((node) => node.id)).toEqual(['f', 'm', 'd', 'v']);
    expect(chain.edges).toEqual([
      { from: 'm', to: 'v', kind: 'verify' },
      { from: 'f', to: 'm', kind: 'moderator_confirm' },
      { from: 'f', to: 'm', kind: 'moderator_appoint' },
    ]);
    expect(chain.edges.map((item) => item.kind)).not.toContain('moderator_propose');
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
      edge({ id: 'a1', subjectId: 's', actorId: 'missing', kind: 'moderator_appoint', createdAt: 4 }),
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
