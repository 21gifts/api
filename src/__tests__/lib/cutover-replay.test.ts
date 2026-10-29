import { describe, it, expect, vi } from 'vitest';
import { InMemoryAuthStore, type Account, type AccountRole } from '@/lib/auth/store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { unsignedConversationDefaults } from '@/lib/conversation';
import { replayPayoutWindow, type ReplayDeps } from '@/lib/cutover-replay';
import type { FundingGrant } from '@/lib/funding';
import { InMemoryFundingStore, loadGrantEffective } from '@/lib/funding-store';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { MESSAGE_LIST_LIMIT, unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryTrustStore } from '@/lib/trust-store';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

const PHOTO = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
const DAY = '2026-10-29';
const NEXT_DAY = '2026-10-30';
const FROM = Date.parse('2026-10-29T23:00:00.000Z');
const TO = Date.parse('2026-10-30T01:00:00.000Z');
const NOW = Date.parse('2026-10-30T01:30:00.000Z');
const PLATFORM = 'p0000000-0000-4000-8000-000000000000';
const ADA = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Spend stand-in that keeps one record per bucket, day, and address, like spend's day files. */
function fakeSpend(): {
  booked: { kind: string; address: string; day: string; messageId: string }[];
  ping: ReturnType<typeof vi.fn>;
  pingOnDay: ReturnType<typeof vi.fn>;
} {
  const booked: { kind: string; address: string; day: string; messageId: string }[] = [];
  const book = (
    kind: string,
    address: string,
    day: string,
    messageId: string,
  ): { status: 'accepted' } | { status: 'skipped'; reason: string } => {
    if (booked.some((row) => row.kind === kind && row.address === address && row.day === day)) {
      return { status: 'skipped', reason: 'paid' };
    }
    booked.push({ kind, address, day, messageId });
    return { status: 'accepted' };
  };
  return {
    booked,
    ping: vi.fn(async (address: string, messageId: string, kind?: string) => {
      book(kind ?? 'daily', address, kind === 'welcome' ? 'welcome' : NEXT_DAY, messageId);
    }),
    pingOnDay: vi.fn(
      async (address: string, messageId: string, day: string, _grant?: string, kind?: string) =>
        book(kind ?? 'daily', address, day, messageId),
    ),
  };
}

function admitted(accountId: string): FundingGrant {
  return {
    accountId,
    status: 'admitted',
    appliedAt: 1,
    decidedAt: 2,
    decidedBy: PLATFORM,
    trialUtcDate: null,
    admittedAt: 2,
    note: null,
  };
}

function gift(recipientWosUser: string, paidAt: string, kind: GiftRow['kind'] = 'daily'): GiftRow {
  return { paidAt: new Date(paidAt), amountSats: 1000, recipientWosUser, kind };
}

async function harness(
  opts: {
    gifts?: GiftRow[];
    grants?: FundingGrant[];
    legacy?: Map<string, string>;
  } = {},
): Promise<{
  messages: InMemoryMessageStore;
  conversations: InMemoryConversationStore;
  trust: InMemoryTrustStore;
  spend: ReturnType<typeof fakeSpend>;
  deps: ReplayDeps;
  member: (
    id: string,
    username: string,
    role?: AccountRole,
    wallet?: boolean,
    extra?: Partial<Account>,
  ) => Promise<void>;
  verifyWallet: (id: string, username: string) => Promise<void>;
  post: (id: string, accountId: string, at: string, photo?: boolean) => Promise<void>;
  run: (dryRun?: boolean) => ReturnType<typeof replayPayoutWindow>;
}> {
  const auth = new InMemoryAuthStore();
  const legacy = opts.legacy;
  if (legacy !== undefined) {
    Object.assign(auth, {
      listLegacyPayoutHandles: async (): Promise<Map<string, string>> => new Map(legacy),
    });
  }
  const messages = new InMemoryMessageStore();
  const conversations = new InMemoryConversationStore();
  const trust = new InMemoryTrustStore();
  const funding = new InMemoryFundingStore(opts.grants ?? []);
  const spend = fakeSpend();
  await auth.createAccount(account(PLATFORM, 'platform', 'founder', { isPlatform: true }));
  const verifyWallet = async (accountId: string, username: string): Promise<void> => {
    const pubkey = `02${accountId.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`;
    await auth.claimSparkPubkey(accountId, pubkey);
    await auth.markSparkPubkeyVerified(accountId, pubkey, username, 1);
  };
  const deps: ReplayDeps = {
    auth,
    messages,
    conversations,
    funding,
    trust,
    gifts: new InMemoryGiftStore(opts.gifts ?? []),
    spendPing: spend,
    pingOnDay: spend.pingOnDay,
    lnurlServer: LNURL_SERVER,
    now: () => NOW,
  };
  return {
    messages,
    conversations,
    trust,
    spend,
    deps,
    member: async (accountId, username, role = 'verified', wallet = true, extra = {}) => {
      await auth.createAccount(
        account(accountId, username, role, { walletRequired: true, ...extra }),
      );
      if (wallet) {
        await verifyWallet(accountId, username);
      }
    },
    verifyWallet,
    post: async (messageId, accountId, at, photo = true) => {
      await messages.create(
        {
          id: messageId,
          accountId,
          name: 'Member',
          text: `post ${messageId}`,
          createdAt: new Date(at),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
        },
        photo ? PHOTO : undefined,
      );
    },
    run: (dryRun = false) => replayPayoutWindow(deps, { fromMs: FROM, toMs: TO, dryRun }),
  };
}

function account(
  accountId: string,
  username: string,
  role: AccountRole,
  extra: Partial<Account> = {},
): Account {
  return {
    id: accountId,
    linkingKey: null,
    role,
    name: username,
    username,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${accountId.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...extra,
  };
}

describe('replayPayoutWindow', () => {
  it('pays a post before 00:00 once on its own day and still pays a post after 00:00 on the new day', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T23:30:00.000Z');
    await h.post(id(2), ADA, '2026-10-29T23:45:00.000Z');
    await h.post(id(3), ADA, '2026-10-30T00:30:00.000Z');

    const first = await h.run();
    const daily = first.events.filter((e) => e.payout === 'daily');
    expect(daily).toEqual([
      {
        trigger: 'post',
        eventId: id(1),
        at: '2026-10-29T23:30:00.000Z',
        day: DAY,
        accountId: ADA,
        username: 'ada',
        payout: 'daily',
        messageId: id(1),
        status: 'paid',
      },
      expect.objectContaining({
        eventId: id(2),
        status: 'skipped',
        reason: 'already_paid',
        detail: 'this_run',
      }),
      expect.objectContaining({ eventId: id(3), day: NEXT_DAY, status: 'paid' }),
    ]);
    expect(h.spend.pingOnDay.mock.calls).toEqual([
      ['ada@example.test', id(1), DAY, 'admitted', 'daily'],
      ['ada@example.test', id(3), NEXT_DAY, 'admitted', 'daily'],
    ]);
    expect(JSON.stringify(first)).not.toContain('@example.test');
    expect(h.spend.booked).toEqual([
      { kind: 'daily', address: 'ada@example.test', day: DAY, messageId: id(1) },
      { kind: 'daily', address: 'ada@example.test', day: NEXT_DAY, messageId: id(3) },
    ]);

    const second = await h.run();
    expect(second.events.find((e) => e.eventId === id(1))).toMatchObject({
      status: 'skipped',
      reason: 'already_paid',
      detail: 'spend',
    });
    expect(second.events.find((e) => e.eventId === id(2))).toMatchObject({
      reason: 'already_paid',
      detail: 'this_run',
    });
    expect(second.events.find((e) => e.eventId === id(3))).toMatchObject({
      reason: 'already_paid',
      detail: 'spend',
    });
    expect(second.totals).toMatchObject({ paid: 0, skipped: 3 });
    expect(h.spend.booked).toHaveLength(2);
  });

  it('skips a member already paid that day on the old external address or the wallet', async () => {
    const h = await harness({
      grants: [admitted(ADA), admitted(BOB)],
      legacy: new Map([[ADA, 'adawos']]),
      gifts: [
        gift(' AdaWos@walletofsatoshi.com ', '2026-10-29T12:00:00.000Z'),
        gift('bob', '2026-10-29T13:00:00.000Z'),
        gift('ada', '2026-10-28T12:00:00.000Z'),
        gift('ada', 'not a date'),
        gift('ada', '2026-10-29T14:00:00.000Z', 'welcome'),
      ],
    });
    await h.member(ADA, 'ada', 'moderator');
    await h.member(BOB, 'bob', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T23:30:00.000Z');
    await h.post(id(2), BOB, '2026-10-29T23:31:00.000Z');
    await h.post(id(3), ADA, '2026-10-30T00:30:00.000Z');

    const result = await h.run();
    expect(result.events.map((e) => [e.eventId, e.day, e.status, e.detail])).toEqual([
      [id(1), DAY, 'skipped', 'ledger'],
      [id(2), DAY, 'skipped', 'ledger'],
      [id(3), NEXT_DAY, 'paid', undefined],
    ]);
    expect(result.events[0]?.reason).toBe('already_paid');
    expect(h.spend.pingOnDay).toHaveBeenCalledTimes(1);
  });

  it('skips a member without a wallet and pays on a later run after login', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada', 'moderator', false);
    await h.post(id(1), ADA, '2026-10-29T23:30:00.000Z');

    const before = await h.run();
    expect(before.events).toEqual([
      expect.objectContaining({
        eventId: id(1),
        username: 'ada',
        status: 'skipped',
        reason: 'no_wallet',
      }),
    ]);
    expect(h.spend.pingOnDay).not.toHaveBeenCalled();

    await h.verifyWallet(ADA, 'ada');
    const after = await h.run();
    expect(after.events).toEqual([expect.objectContaining({ eventId: id(1), status: 'paid' })]);
    expect(h.spend.booked).toEqual([
      { kind: 'daily', address: 'ada@example.test', day: DAY, messageId: id(1) },
    ]);
  });

  it('reports a /trial of the previous day as not eligible and pays an /admit on its day', async () => {
    const h = await harness({
      grants: [
        {
          accountId: ADA,
          status: 'trial',
          appliedAt: 1,
          decidedAt: Date.parse('2026-10-29T23:40:00.000Z'),
          decidedBy: PLATFORM,
          trialUtcDate: DAY,
          admittedAt: null,
          note: null,
        },
        {
          ...admitted(BOB),
          decidedAt: Date.parse('2026-10-29T23:50:00.000Z'),
          admittedAt: Date.parse('2026-10-29T23:50:00.000Z'),
        },
      ],
    });
    await h.member(ADA, 'ada', 'moderator');
    await h.member(BOB, 'bob', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T10:00:00.000Z');
    await h.post(id(2), BOB, '2026-10-29T09:00:00.000Z');
    await h.post(id(3), BOB, '2026-10-29T11:00:00.000Z', false);

    const result = await h.run();
    expect(result.events).toEqual([
      expect.objectContaining({
        trigger: 'trial',
        eventId: ADA,
        at: '2026-10-29T23:40:00.000Z',
        username: 'ada',
        status: 'skipped',
        reason: 'not_eligible',
        detail: 'trial_day_passed',
      }),
      expect.objectContaining({
        trigger: 'admit',
        eventId: BOB,
        day: DAY,
        messageId: id(2),
        status: 'paid',
      }),
    ]);
    expect(h.spend.pingOnDay.mock.calls).toEqual([
      ['bob@example.test', id(2), DAY, 'admitted', 'daily'],
    ]);
  });

  it('still reports a /trial of the previous day once a read stored it as pending', async () => {
    const h = await harness({
      grants: [
        {
          accountId: ADA,
          status: 'trial',
          appliedAt: 1,
          decidedAt: Date.parse('2026-10-29T23:40:00.000Z'),
          decidedBy: PLATFORM,
          trialUtcDate: DAY,
          admittedAt: null,
          note: null,
        },
      ],
    });
    await h.member(ADA, 'ada', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T23:45:00.000Z');
    const read = await loadGrantEffective(h.deps.funding, ADA, NOW);
    expect(read).toMatchObject({ status: 'pending', trialUtcDate: null });

    const result = await h.run();
    expect(result.events).toEqual([
      expect.objectContaining({
        trigger: 'trial',
        eventId: ADA,
        username: 'ada',
        status: 'skipped',
        reason: 'not_eligible',
        detail: 'trial_day_passed',
      }),
      expect.objectContaining({
        trigger: 'post',
        eventId: id(1),
        status: 'skipped',
        reason: 'not_eligible',
        detail: 'trial_day_passed',
      }),
    ]);
    expect(h.spend.pingOnDay).not.toHaveBeenCalled();
  });

  it('pays a same-day /trial and skips a decision without a media post that day', async () => {
    const trial: FundingGrant = {
      accountId: ADA,
      status: 'trial',
      appliedAt: 1,
      decidedAt: Date.parse('2026-10-29T23:10:00.000Z'),
      decidedBy: PLATFORM,
      trialUtcDate: DAY,
      admittedAt: null,
      note: null,
    };
    const h = await harness({
      grants: [
        trial,
        { ...admitted(BOB), decidedAt: Date.parse('2026-10-29T23:20:00.000Z') },
        { ...trial, accountId: id(9), status: 'rejected', decidedAt: FROM + 1 },
        { ...trial, accountId: id(8), decidedAt: null },
      ],
    });
    h.deps.now = () => Date.parse('2026-10-29T23:55:00.000Z');
    await h.member(ADA, 'ada');
    await h.member(BOB, 'bob', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T08:00:00.000Z');
    await h.post(id(2), BOB, '2026-10-28T08:00:00.000Z');

    const result = await h.run();
    expect(result.events.map((e) => [e.trigger, e.status, e.detail])).toEqual([
      ['trial', 'paid', undefined],
      ['admit', 'skipped', 'no_media_post'],
    ]);
    expect(h.spend.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      id(1),
      DAY,
      'trial',
      'daily',
    ]);
  });

  it('pays an /admit for the About-me media of that day, as the live decision does', async () => {
    const h = await harness({
      grants: [{ ...admitted(ADA), decidedAt: Date.parse('2026-10-29T23:30:00.000Z') }],
    });
    await h.member(ADA, 'ada', 'moderator', true, { profileMessageId: id(1) });
    await h.post(id(1), ADA, '2026-10-29T08:00:00.000Z');

    const result = await h.run();
    expect(result.events).toEqual([
      expect.objectContaining({ trigger: 'admit', messageId: id(1), status: 'paid' }),
    ]);
  });

  it('replays moderator-group messages as moderator payouts on their day', async () => {
    const h = await harness({
      grants: [admitted(ADA), admitted(BOB), admitted(id(7))],
      gifts: [gift('bob', '2026-10-29T15:00:00.000Z', 'moderator')],
    });
    await h.member(ADA, 'ada', 'moderator', true, { profileMessageId: id(5) });
    await h.member(BOB, 'bob', 'moderator');
    await h.member(id(7), 'cy', 'verified');
    await h.member(id(6), 'dee', 'moderator');
    await h.post(id(5), ADA, '2026-10-29T06:00:00.000Z', false);
    await h.post(id(1), ADA, '2026-10-29T07:00:00.000Z', false);
    await h.post(id(2), BOB, '2026-10-29T07:00:00.000Z', false);
    await h.post(id(3), id(6), '2026-10-28T07:00:00.000Z', false);
    const group = await h.conversations.ensureModeratorGroup(PLATFORM, new Date(FROM));
    const say = async (messageId: string, sender: string | null, at: string): Promise<void> => {
      await h.conversations.appendMessage({
        id: messageId,
        conversationId: group.id,
        text: 'hi',
        createdAt: new Date(at),
        senderAccountId: sender,
        senderPubkey: null,
        name: 'Member',
        ...unsignedConversationDefaults(),
      });
    };
    await say('g-before', ADA, '2026-10-29T22:00:00.000Z');
    await say('g-ada', ADA, '2026-10-29T23:05:00.000Z');
    await say('g-ada-2', ADA, '2026-10-29T23:06:00.000Z');
    await say('g-bob', BOB, '2026-10-29T23:07:00.000Z');
    await say('g-cy', id(7), '2026-10-29T23:08:00.000Z');
    await say('g-dee', id(6), '2026-10-29T23:09:00.000Z');
    await say('g-none', null, '2026-10-29T23:10:00.000Z');

    const result = await h.run();
    expect(result.events.map((e) => [e.eventId, e.payout, e.status, e.detail])).toEqual([
      ['g-ada', 'moderator', 'paid', undefined],
      ['g-ada-2', 'moderator', 'skipped', 'this_run'],
      ['g-bob', 'moderator', 'skipped', 'ledger'],
      ['g-cy', 'moderator', 'skipped', 'not_moderator'],
      ['g-dee', 'moderator', 'skipped', 'grant'],
    ]);
    expect(h.spend.pingOnDay.mock.calls).toEqual([
      ['ada@example.test', 'g-ada', DAY, undefined, 'moderator'],
    ]);
  });

  it('skips a moderator message without a living-room post that day', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada', 'moderator');
    await h.post(id(1), ADA, '2026-10-28T07:00:00.000Z', false);
    const group = await h.conversations.ensureModeratorGroup(PLATFORM, new Date(FROM));
    await h.conversations.appendMessage({
      id: 'g-ada',
      conversationId: group.id,
      text: 'hi',
      createdAt: new Date('2026-10-29T23:05:00.000Z'),
      senderAccountId: ADA,
      senderPubkey: null,
      name: 'Ada',
      ...unsignedConversationDefaults(),
    });
    const result = await h.run();
    expect(result.events).toEqual([
      expect.objectContaining({ reason: 'not_eligible', detail: 'no_public_post' }),
    ]);
  });

  it('hands welcome triggers of verified members to the welcome path once per account', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada');
    await h.member(BOB, 'bob', 'verified', false);
    await h.post(id(1), ADA, '2026-10-29T23:30:00.000Z');
    await h.post(id(2), ADA, '2026-10-29T23:40:00.000Z');
    await h.post(id(3), BOB, '2026-10-29T23:35:00.000Z');
    await h.post(id(4), PLATFORM, '2026-10-29T23:36:00.000Z');
    await h.trust.insertEdge({
      id: 'edge-1',
      subjectId: BOB,
      actorId: PLATFORM,
      kind: 'verify',
      createdAt: Date.parse('2026-10-29T23:20:00.000Z'),
    });
    await h.trust.insertEdge({
      id: 'edge-2',
      subjectId: ADA,
      actorId: PLATFORM,
      kind: 'moderator_propose',
      createdAt: Date.parse('2026-10-29T23:21:00.000Z'),
    });

    const result = await h.run();
    const welcome = result.events.filter((e) => e.payout === 'welcome');
    expect(welcome.map((e) => [e.eventId, e.accountId, e.status, e.reason])).toEqual([
      ['edge-1', BOB, 'skipped', 'no_wallet'],
      [id(1), ADA, 'sent', undefined],
    ]);
    expect(h.spend.ping.mock.calls).toEqual([['ada@example.test', id(2), 'welcome']]);
    expect(result.events.some((e) => e.accountId === PLATFORM)).toBe(false);
  });

  it('dry-run reports what it would do and changes nothing', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada');
    await h.post(id(1), ADA, '2026-10-29T23:30:00.000Z');
    await h.post(id(2), ADA, '2026-10-29T23:31:00.000Z');

    const result = await h.run(true);
    expect(result.events.map((e) => [e.trigger, e.status, e.detail])).toEqual([
      ['post', 'would_pay', undefined],
      ['welcome', 'would_send', undefined],
      ['post', 'skipped', 'this_run'],
    ]);
    expect(result.totals).toEqual({
      events: 3,
      paid: 0,
      wouldPay: 1,
      sent: 0,
      wouldSend: 1,
      skipped: 1,
      failed: 0,
    });
    expect(h.spend.ping).not.toHaveBeenCalled();
    expect(h.spend.pingOnDay).not.toHaveBeenCalled();
    expect(h.spend.booked).toEqual([]);
  });

  it('reports spend skips, failures, missing accounts, basis members, and profile notes', async () => {
    const h = await harness({
      grants: [
        admitted(ADA),
        admitted(BOB),
        // A basis member is never eligible, so its trial of an earlier day is `grant`, not
        // `trial_day_passed`, which would invite a payout by hand.
        { ...admitted(id(7)), status: 'trial', trialUtcDate: '2026-10-28', admittedAt: null },
        admitted(id(6)),
      ],
    });
    await h.member(ADA, 'ada', 'moderator');
    await h.member(BOB, 'bob', 'moderator');
    await h.member(id(7), 'cy', 'basis');
    await h.member(id(6), 'dee', 'moderator', true, { profileMessageId: id(5) });
    await h.post(id(1), ADA, '2026-10-29T23:01:00.000Z');
    await h.post(id(2), BOB, '2026-10-29T23:02:00.000Z');
    await h.post(id(3), id(7), '2026-10-29T23:03:00.000Z');
    await h.post(id(4), 'ffffffff-0000-4000-8000-000000000000', '2026-10-29T23:04:00.000Z');
    await h.post(id(5), id(6), '2026-10-29T23:05:00.000Z');
    await h.post(id(6), BOB, '2026-10-29T23:06:00.000Z', false);
    h.spend.pingOnDay
      .mockResolvedValueOnce({ status: 'skipped', reason: 'payments_disabled' })
      .mockResolvedValueOnce({ status: 'failed' });

    const result = await h.run();
    expect(result.events.map((e) => [e.eventId, e.status, e.reason, e.detail])).toEqual([
      [id(1), 'skipped', 'spend', 'payments_disabled'],
      [id(2), 'failed', undefined, undefined],
      [id(3), 'skipped', 'not_eligible', 'grant'],
      [id(4), 'skipped', 'not_eligible', 'no_account'],
      [id(5), 'skipped', 'not_eligible', 'profile_note'],
    ]);
    expect(result.events[3]?.username).toBeNull();
    expect(result.totals).toMatchObject({ events: 5, skipped: 4, failed: 1 });
  });

  it('reads every feed page and every moderator-group page that reaches the window', async () => {
    const h = await harness({ grants: [admitted(ADA)] });
    await h.member(ADA, 'ada', 'moderator');
    const group = await h.conversations.ensureModeratorGroup(PLATFORM, new Date(FROM));
    const base = Date.parse('2026-10-29T23:00:00.000Z');
    for (let i = 0; i < MESSAGE_LIST_LIMIT + 1; i += 1) {
      const at = new Date(base + i * 1000).toISOString();
      // Only the oldest post has media, so it is reachable only on the second feed page.
      await h.post(id(1000 + i), ADA, at, i === 0);
      await h.conversations.appendMessage({
        id: `g-${i}`,
        conversationId: group.id,
        text: 'hi',
        createdAt: new Date(at),
        senderAccountId: ADA,
        senderPubkey: null,
        name: 'Ada',
        ...unsignedConversationDefaults(),
      });
    }

    const result = await h.run(true);
    expect(result.events.filter((e) => e.payout === 'moderator')).toHaveLength(
      MESSAGE_LIST_LIMIT + 1,
    );
    expect(result.events.filter((e) => e.trigger === 'post').map((e) => e.eventId)).toEqual([
      id(1000),
    ]);
  });

  it('finds the media post of an /admit day behind more than a page of newer notes', async () => {
    const h = await harness({
      grants: [
        {
          ...admitted(ADA),
          decidedAt: Date.parse('2026-10-29T23:50:00.000Z'),
          admittedAt: Date.parse('2026-10-29T23:50:00.000Z'),
        },
      ],
    });
    h.deps.now = () => Date.parse('2026-10-30T06:00:00.000Z');
    await h.member(ADA, 'ada', 'moderator');
    await h.post(id(1), ADA, '2026-10-29T09:00:00.000Z');
    const base = Date.parse('2026-10-29T12:00:00.000Z');
    for (let i = 0; i < MESSAGE_LIST_LIMIT + 1; i += 1) {
      await h.post(id(2000 + i), ADA, new Date(base + i * 1000).toISOString(), false);
    }

    const result = await h.run(true);
    expect(result.events).toEqual([
      expect.objectContaining({ trigger: 'admit', messageId: id(1), status: 'would_pay' }),
    ]);
  });

  it('stops paging once a full page ends before the window', async () => {
    const h = await harness();
    await h.member(ADA, 'ada', 'moderator');
    const group = await h.conversations.ensureModeratorGroup(PLATFORM, new Date(FROM));
    const base = FROM - 10 * 60 * 60 * 1000;
    for (let i = 0; i < MESSAGE_LIST_LIMIT + 1; i += 1) {
      const at = new Date(base + i * 1000);
      await h.post(id(1000 + i), ADA, at.toISOString(), false);
      await h.conversations.appendMessage({
        id: `g-${i}`,
        conversationId: group.id,
        text: 'hi',
        createdAt: at,
        senderAccountId: ADA,
        senderPubkey: null,
        name: 'Ada',
        ...unsignedConversationDefaults(),
      });
    }
    const listFeed = vi.spyOn(h.messages, 'listFeed');
    const listThreadPage = vi.spyOn(h.conversations, 'listThreadPage');
    const result = await h.run(true);
    expect(result.events).toEqual([]);
    expect(listFeed).toHaveBeenCalledTimes(1);
    expect(listThreadPage).toHaveBeenCalledTimes(1);
  });
});
