import { describe, expect, it } from 'vitest';
import { InMemoryApiLogStore } from '@/lib/api-log';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryContactStore } from '@/lib/contact-store';
import { InMemoryConversationStore, type ConversationStore } from '@/lib/conversation-store';
import { isDebugCatalogTable, loadDebugTables } from '@/lib/debug-catalog';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { MESSAGE_LIST_LIMIT, unsignedNostrDefaults } from '@/lib/message';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { InMemoryTrustStore } from '@/lib/trust-store';

describe('isDebugCatalogTable', () => {
  it('accepts allowlisted names and rejects others', () => {
    expect(isDebugCatalogTable('account')).toBe(true);
    expect(isDebugCatalogTable('auth_session')).toBe(true);
    expect(isDebugCatalogTable('api_log')).toBe(true);
    expect(isDebugCatalogTable('nope')).toBe(false);
  });
});

describe('loadDebugTables', () => {
  it('serializes every wired table', async () => {
    const auth = new InMemoryAuthStore();
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await auth.createAccount({
      id: accountId,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await auth.createAccount({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      linkingKey: null,
      role: 'basis',
      name: 'Bea',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await auth.createPasskeyCredential({
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId,
      createdAt: 2,
    });
    await auth.createSession({ token: 'sess', accountId, createdAt: 3 });
    await auth.putVerification({
      accountId,
      address: 'ada@walletofsatoshi.com',
      nonce: 'ab'.repeat(16),
      createdAt: 4,
    });
    await auth.createPasskeyChallenge({
      id: 'chal',
      type: 'register',
      challenge: 'ch',
      accountId,
      consumed: false,
      createdAt: 5,
    });
    const contacts = new InMemoryContactStore();
    await contacts.create({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      accountId,
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const threadId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const conversations = new InMemoryConversationStore(
      [
        {
          id: threadId,
          kind: 'member_platform',
          accountA: accountId,
          accountB: null,
          counterpartPubkey: null,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          lastMessageAt: new Date('2026-09-01T01:00:00.000Z'),
          name: 'Ada',
          lastText: 'hi',
          lastSenderAccountId: accountId,
          lastActorAccountId: accountId,
          lastSats: 0,
        },
      ],
      [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          conversationId: threadId,
          text: 'hi',
          createdAt: new Date('2026-09-01T01:00:00.000Z'),
          senderAccountId: accountId,
          senderPubkey: null,
          name: 'Ada',
          actorAccountId: accountId,
          actorName: 'Ada',
          sats: 0,
          eventId: null,
          nostrPublishState: 'pending',
          nostrEvent: null,
          claimedUntil: null,
        },
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
          conversationId: threadId,
          text: 'later',
          createdAt: new Date('2026-09-01T01:00:00.000Z'),
          senderAccountId: accountId,
          senderPubkey: null,
          name: 'Ada',
          actorAccountId: accountId,
          actorName: 'Ada',
          sats: 0,
          eventId: null,
          nostrPublishState: 'pending',
          nostrEvent: null,
          claimedUntil: null,
        },
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed',
          conversationId: threadId,
          text: 'earlier',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          senderAccountId: accountId,
          senderPubkey: null,
          name: 'Ada',
          sats: 0,
          eventId: null,
          nostrPublishState: 'pending',
          nostrEvent: null,
          claimedUntil: null,
        },
      ],
      [{ accountId, conversationId: threadId, lastReadAt: new Date('2026-09-01T02:00:00.000Z') }],
    );
    await conversations.appendMessage(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeec',
        conversationId: threadId,
        text: 'still',
        createdAt: new Date('2026-09-01T01:30:00.000Z'),
        senderAccountId: accountId,
        senderPubkey: null,
        name: 'Ada',
        actorAccountId: accountId,
        actorName: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) },
      [{ contentType: 'image/png', bytes: new Uint8Array([4, 5]) }],
    );
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        accountId,
        name: 'Ada',
        text: 'note',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      {
        contentType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      },
      undefined,
      [
        { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) },
        { contentType: 'image/png', bytes: new Uint8Array([6]) },
      ],
    );
    await messages.create(
      {
        id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
        accountId,
        name: 'Ada',
        text: 'plain',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      {
        contentType: 'image/jpeg',
        bytes: new Uint8Array([7]),
      },
      undefined,
      [{ contentType: 'image/webp', bytes: new Uint8Array([8, 9]) }],
    );
    await messages.create(
      {
        id: 'ffffffff-ffff-4fff-8fff-fffffffffffd',
        accountId,
        name: 'Ada',
        text: 'later extra',
        createdAt: new Date('2026-09-01T00:02:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([10]) },
      undefined,
      [{ contentType: 'image/jpeg', bytes: new Uint8Array([11]) }],
    );
    await messages.create({
      id: 'ffffffff-ffff-4fff-8fff-fffffffffffc',
      accountId,
      name: 'Ada',
      text: 'bare',
      createdAt: new Date('2026-09-01T00:03:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.recordInvoiceAttempt({
      id: 'inv',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      payerAccountId: accountId,
      authorAccountId: accountId,
      amountSats: 21,
      lightningAddress: null,
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: null,
      paymentHash: null,
      description: null,
      descriptionHash: null,
      isNip57Invoice: false,
      lnurlResponse: null,
      conversationId: threadId,
      conversationMessageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    await messages.recordInvoiceAttempt({
      id: 'inv-forum',
      createdAt: new Date('2026-09-01T00:00:01.000Z'),
      messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      payerAccountId: accountId,
      authorAccountId: accountId,
      amountSats: 1,
      lightningAddress: null,
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: null,
      paymentHash: null,
      description: null,
      descriptionHash: null,
      isNip57Invoice: false,
      lnurlResponse: null,
    });
    await messages.recordZapIngest({
      id: 'ing',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      receiptId: 'r',
      noteEventId: null,
      messageId: null,
      outcome: 'rejected',
      reason: 'x',
      amountSats: null,
      receiptPubkey: null,
      receipt: {},
    });
    await messages.recordZapReceipt(
      'receipt-event',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      21,
      null,
    );
    await messages.recordZapper(
      'aa'.repeat(32),
      'receipt-event',
      new Date('2026-09-01T00:00:00.000Z'),
    );
    await messages.blockPubkeyAndHideRows(
      'bb'.repeat(32),
      new Date('2026-09-01T00:00:00.000Z'),
      accountId,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    await messages.claimZapPayment(
      'aa'.repeat(32),
      'receipt-event',
      new Date('2026-09-01T00:00:00.000Z'),
    );
    await auth.setNostrKeyIfAbsent(accountId, {
      pubkey: 'ab'.repeat(32),
      ciphertext: new Uint8Array([9, 8]),
      kekId: 1,
      custody: 'custodial',
    });
    const notifications = new InMemoryNotificationStore([
      {
        id: 'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn',
        recipientAccountId: accountId,
        actorAccountId: accountId,
        type: 'forum_post',
        parentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        name: 'Ada',
        text: 'note',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        readAt: null,
      },
      {
        id: 'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnno',
        recipientAccountId: accountId,
        actorAccountId: accountId,
        type: 'forum_reply',
        parentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replyId: 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr',
        name: 'Ada',
        text: 'later',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        readAt: null,
      },
      {
        id: 'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnp',
        recipientAccountId: accountId,
        actorAccountId: accountId,
        type: 'zap',
        parentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replyId: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
        name: 'Ada',
        text: '21',
        createdAt: new Date('2026-09-01T04:00:00.000Z'),
        readAt: new Date('2026-09-01T05:00:00.000Z'),
      },
    ]);
    const push = new InMemoryPushStore();
    await push.upsertSubscription({
      endpoint: 'https://push.example/1',
      accountId,
      p256dh: 'p256',
      auth: 'auth',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await push.upsertSubscription({
      endpoint: 'https://push.example/2',
      accountId,
      p256dh: 'p256b',
      auth: 'authb',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await push.upsertSubscription({
      endpoint: 'https://push.example/0',
      accountId,
      p256dh: 'p256c',
      auth: 'authc',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    await push.enqueue({
      id: 'outbox-1',
      accountId,
      type: 'forum',
      messageId: null,
      payload: '{}',
      status: 'pending',
      attempts: 0,
      claimedUntil: new Date('2026-09-01T00:30:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      deliveredEndpoints: [],
    });
    await push.enqueue({
      id: 'outbox-2',
      accountId,
      type: 'zap',
      messageId: null,
      payload: '{}',
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      deliveredEndpoints: [],
    });
    await push.enqueue({
      id: 'outbox-3',
      accountId,
      type: 'conversation',
      messageId: null,
      payload: '{}',
      status: 'sent',
      attempts: 0,
      claimedUntil: null,
      createdAt: new Date('2026-09-01T04:00:00.000Z'),
      deliveredEndpoints: [],
    });
    const trust = new InMemoryTrustStore();
    await trust.insertEdge({
      id: 'edge-1',
      subjectId: accountId,
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      kind: 'verify',
      createdAt: 9,
    });
    await trust.insertEdge({
      id: 'edge-2',
      subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actorId: accountId,
      kind: 'verify',
      createdAt: 9,
    });
    await trust.insertEdge({
      id: 'edge-0',
      subjectId: accountId,
      actorId: accountId,
      kind: 'moderator_propose',
      createdAt: 11,
    });
    const gifts = new InMemoryGiftStore([
      {
        paidAt: new Date('2026-09-01T00:00:00.000Z'),
        amountSats: 1000,
        recipientWosUser: 'ada',
      },
    ]);
    const tables = await loadDebugTables({
      auth,
      messages,
      contacts,
      conversations,
      notifications,
      push,
      trust,
      gifts,
    });
    expect(tables.account).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: accountId,
          viewKey: 'a'.repeat(64),
          nostrPubkey: 'ab'.repeat(32),
          nostrNsecCiphertext: '0908',
        }),
        expect.objectContaining({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          nostrPubkey: null,
          nostrNsecCiphertext: null,
          nostrKekId: 1,
          nostrKeyCustody: 'custodial',
        }),
      ]),
    );
    expect(tables.passkey_credential).toHaveLength(1);
    expect(tables.auth_session[0]).toEqual(expect.objectContaining({ token: 'sess' }));
    expect(tables.contact).toHaveLength(1);
    expect(tables.conversation).toHaveLength(1);
    expect(tables.conversation_message).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          actorAccountId: accountId,
          actorName: 'Ada',
          giftForMessageId: null,
          photoContentType: null,
          photoBytes: 0,
          extraPhotos: [],
        }),
        expect.objectContaining({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
          photoContentType: null,
          photoBytes: 0,
          extraPhotos: [],
        }),
        expect.objectContaining({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed',
          actorAccountId: null,
          actorName: '',
          giftForMessageId: null,
          photoContentType: null,
          photoBytes: 0,
          extraPhotos: [],
        }),
        expect.objectContaining({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeec',
          photoBytes: 3,
          photoContentType: 'image/jpeg',
          extraPhotos: [{ idx: 1, photoContentType: 'image/png', bytes: 2 }],
        }),
      ]),
    );
    expect(tables.conversation_read).toHaveLength(1);
    expect(tables.message).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          photoBytes: 3,
          extraPhotos: [
            expect.objectContaining({ idx: 1, bytes: 2 }),
            expect.objectContaining({ idx: 2, bytes: 1 }),
          ],
        }),
        expect.objectContaining({
          id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
          photoBytes: 1,
        }),
        expect.objectContaining({
          id: 'ffffffff-ffff-4fff-8fff-fffffffffffc',
          photoBytes: 0,
          photoContentType: null,
        }),
      ]),
    );
    expect(tables.message_extra_photo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idx: 1, bytes: 2 }),
        expect.objectContaining({ idx: 2, bytes: 1 }),
        expect.objectContaining({ idx: 1, bytes: 2, photoContentType: 'image/webp' }),
      ]),
    );
    expect(tables.message_invoice).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inv',
          conversationId: threadId,
          conversationMessageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        }),
        expect.objectContaining({
          id: 'inv-forum',
          conversationId: null,
          conversationMessageId: null,
        }),
      ]),
    );
    expect(tables.nostr_zap_ingest).toHaveLength(1);
    expect(tables.nostr_zap_receipt).toHaveLength(1);
    expect(tables.nostr_zap_receipt[0]).toEqual(
      expect.objectContaining({ payerPubkey: null, zapRequestId: null }),
    );
    expect(tables.nostr_zapper).toEqual([
      expect.objectContaining({ pubkey: 'aa'.repeat(32), receiptEventId: 'receipt-event' }),
    ]);
    expect(tables.nostr_blocked_pubkey).toEqual([
      expect.objectContaining({
        pubkey: 'bb'.repeat(32),
        blockedBy: accountId,
        messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ]);
    expect(tables.notification).toHaveLength(3);
    expect(tables.notification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'zap',
          readAt: '2026-09-01T05:00:00.000Z',
        }),
      ]),
    );
    expect(tables.trust_edge[0]).toEqual(expect.objectContaining({ id: 'edge-0' }));
    expect(tables.push_subscription).toHaveLength(3);
    expect(tables.push_outbox).toHaveLength(3);
    expect(tables.trust_edge).toHaveLength(3);
    expect(tables.gift[0]).toEqual(
      expect.objectContaining({ direction: 'outbound', amountSats: 1000 }),
    );
    expect(tables.db_change).toEqual([]);
    const only = await loadDebugTables({ auth, messages, contacts }, 'btc_usd_daily');
    expect(only.btc_usd_daily).toEqual([]);
    expect(only.account).toEqual([]);
    expect(
      (await loadDebugTables({ auth, messages, contacts }, 'usd_fiat_daily')).usd_fiat_daily,
    ).toEqual([]);
    expect((await loadDebugTables({ auth, messages, contacts }, 'db_change')).db_change).toEqual(
      [],
    );
    const missingOptional = await loadDebugTables({
      auth: new InMemoryAuthStore(),
      messages: new InMemoryMessageStore(),
      contacts: new InMemoryContactStore(),
    });
    expect(missingOptional.conversation).toEqual([]);
    expect(missingOptional.push_outbox).toEqual([]);
    expect(missingOptional.gift).toEqual([]);
    expect(missingOptional.trust_edge).toEqual([]);
    expect(missingOptional.api_log).toEqual([]);
    const audit = await loadDebugTables(
      {
        auth: new InMemoryAuthStore(),
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
        apiLog: new InMemoryApiLogStore([
          {
            id: 'llllllll-llll-4lll-8lll-llllllllllll',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            method: 'GET',
            path: '/healthz',
            status: 200,
            ms: 1,
            accountId: null,
            authKind: 'none',
          },
        ]),
      },
      'api_log',
    );
    expect(audit.api_log).toEqual([
      expect.objectContaining({
        id: 'llllllll-llll-4lll-8lll-llllllllllll',
        method: 'GET',
        path: '/healthz',
        status: 200,
        authKind: 'none',
      }),
    ]);
    const stripped = new InMemoryMessageStore() as MessageStore;
    Object.assign(stripped, {
      listZapReceipts: undefined,
      listZapPayments: undefined,
      listExtraPhotoMeta: undefined,
    });
    const omitted = await loadDebugTables({
      auth: new InMemoryAuthStore(),
      messages: stripped,
      contacts: new InMemoryContactStore(),
    });
    expect(omitted.nostr_zap_receipt).toEqual([]);
    expect(omitted.nostr_zap_payment).toEqual([]);
    expect(omitted.message_extra_photo).toEqual([]);
    const bareActor = await loadDebugTables(
      {
        auth: new InMemoryAuthStore(),
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
        conversations: {
          listAll: async () => [],
          listAllMessages: async () => [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed',
              conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              text: 'earlier',
              createdAt: new Date('2026-09-01T00:00:00.000Z'),
              senderAccountId: accountId,
              senderPubkey: null,
              name: 'Ada',
              sats: 0,
              eventId: null,
              nostrPublishState: 'pending' as const,
              nostrEvent: null,
              claimedUntil: null,
            },
          ],
          listAllReads: async () => [],
          getPhoto: async () => null,
          getExtraPhoto: async () => null,
        } as unknown as ConversationStore,
      },
      'conversation_message',
    );
    expect(bareActor.conversation_message).toEqual([
      expect.objectContaining({
        actorAccountId: null,
        actorName: '',
        giftForMessageId: null,
        photoContentType: null,
        photoBytes: 0,
        extraPhotos: [],
      }),
    ]);
    const giftFor = await loadDebugTables(
      {
        auth: new InMemoryAuthStore(),
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
        conversations: {
          listAll: async () => [],
          listAllMessages: async () => [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed',
              conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              text: '',
              createdAt: new Date('2026-09-01T00:00:00.000Z'),
              senderAccountId: accountId,
              senderPubkey: null,
              name: 'Ada',
              giftForMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              sats: 21,
              eventId: null,
              nostrPublishState: 'pending' as const,
              nostrEvent: null,
              claimedUntil: null,
            },
          ],
          listAllReads: async () => [],
          getPhoto: async () => null,
          getExtraPhoto: async () => null,
        } as unknown as ConversationStore,
      },
      'conversation_message',
    );
    expect(giftFor.conversation_message).toEqual([
      expect.objectContaining({
        giftForMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sats: 21,
        photoContentType: null,
        photoBytes: 0,
        extraPhotos: [],
      }),
    ]);
    const cappedAuth = new InMemoryAuthStore();
    for (let i = 0; i < MESSAGE_LIST_LIMIT + 1; i += 1) {
      await cappedAuth.createSession({
        token: `sess-${i}`,
        accountId: accountId,
        createdAt: i,
      });
    }
    const capped = await loadDebugTables({
      auth: cappedAuth,
      messages: new InMemoryMessageStore(),
      contacts: new InMemoryContactStore(),
    });
    expect(capped.auth_session).toHaveLength(MESSAGE_LIST_LIMIT);
    expect(capped.auth_session[0]).toEqual(
      expect.objectContaining({ createdAt: MESSAGE_LIST_LIMIT }),
    );
    const newestAuth = new InMemoryAuthStore();
    for (let i = 0; i < MESSAGE_LIST_LIMIT + 1; i += 1) {
      await newestAuth.createAccount({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}`,
        linkingKey: null,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: i.toString(16).padStart(64, '0'),
        createdAt: i,
        rulesAgreedAt: null,
      });
    }
    const newestAccounts = await loadDebugTables(
      {
        auth: newestAuth,
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
      },
      'account',
    );
    expect(newestAccounts.account).toHaveLength(MESSAGE_LIST_LIMIT);
    expect(newestAccounts.account[0]).toEqual(
      expect.objectContaining({ createdAt: MESSAGE_LIST_LIMIT }),
    );
    expect(newestAccounts.account[MESSAGE_LIST_LIMIT - 1]).toEqual(
      expect.objectContaining({ createdAt: 1 }),
    );
    const tieAuth = new InMemoryAuthStore();
    await tieAuth.createAccount({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    await tieAuth.createAccount({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000b',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    const tied = await loadDebugTables(
      {
        auth: tieAuth,
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
      },
      'account',
    );
    expect(tied.account.map((row) => (row as { id: string }).id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-00000000000b',
      'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a',
    ]);
    const rates = await loadDebugTables(
      {
        auth: new InMemoryAuthStore(),
        messages: new InMemoryMessageStore(),
        contacts: new InMemoryContactStore(),
        listBtcUsdDaily: async () => [{ day: '2026-09-01', usdPerBtc: '100000' }],
        listUsdFiatDaily: async () => [{ day: '2026-09-01', quote: 'CHF', rate: '0.8' }],
        listDbChange: async () => [{ id: 1, op: 'INSERT' }],
      },
      'btc_usd_daily',
    );
    expect(rates.btc_usd_daily).toEqual([{ day: '2026-09-01', usdPerBtc: '100000' }]);
    expect(
      (
        await loadDebugTables(
          {
            auth: new InMemoryAuthStore(),
            messages: new InMemoryMessageStore(),
            contacts: new InMemoryContactStore(),
            listUsdFiatDaily: async () => [{ day: '2026-09-01', quote: 'CHF', rate: '0.8' }],
          },
          'usd_fiat_daily',
        )
      ).usd_fiat_daily,
    ).toEqual([{ day: '2026-09-01', quote: 'CHF', rate: '0.8' }]);
    expect(
      (
        await loadDebugTables(
          {
            auth: new InMemoryAuthStore(),
            messages: new InMemoryMessageStore(),
            contacts: new InMemoryContactStore(),
            listDbChange: async () => [{ id: 1, op: 'INSERT' }],
          },
          'db_change',
        )
      ).db_change,
    ).toEqual([{ id: 1, op: 'INSERT' }]);
  });

  it('dumps all-null nostr fields when listNostrKeys returns no row', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    Object.assign(auth, { listNostrKeys: async () => [] });
    const tables = await loadDebugTables(
      { auth, messages: new InMemoryMessageStore(), contacts: new InMemoryContactStore() },
      'account',
    );
    expect(tables.account).toEqual([
      expect.objectContaining({
        nostrPubkey: null,
        nostrKekId: null,
        nostrKeyCustody: null,
      }),
    ]);
  });
});
