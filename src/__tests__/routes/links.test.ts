import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { MessageStore } from '@/lib/message-store';
import { linksRoutes } from '@/routes/links';
import { createApp } from '@/server';

const PREFIX = 'd70c4763';
const MESSAGE_ID = 'd70c4763-3033-43da-817a-2c7de9938f27';
const MESSAGE_ID_UPPER = 'D70C4763-3033-43DA-817A-2C7DE9938F27';
const OTHER_MESSAGE_ID = 'd70c4763-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = 'd70c4763-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mount(
  messages: Pick<MessageStore, 'listIdsByPrefix'>,
  accounts: Pick<AuthStore, 'listIdsByPrefix'>,
): Hono {
  return new Hono().route('/links', linksRoutes({ messages, accounts }));
}

function throwingPrefix(): Pick<MessageStore, 'listIdsByPrefix'> {
  return {
    listIdsByPrefix: async (): Promise<never> => {
      throw new Error('boom');
    },
  };
}

describe('GET /links/:code', () => {
  it('returns 400 invalid_code for a 7-char hex string', async () => {
    const res = await mount(throwingPrefix(), throwingPrefix()).request('/links/abcdefg');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns 400 invalid_code for a 9-char hex string', async () => {
    const res = await mount(throwingPrefix(), throwingPrefix()).request('/links/abcdefghi');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns 400 invalid_code for eight non-hex letters', async () => {
    const res = await mount(throwingPrefix(), throwingPrefix()).request('/links/zzzzzzzz');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns 400 invalid_code for a trailing space', async () => {
    const res = await mount(throwingPrefix(), throwingPrefix()).request(
      `/links/${encodeURIComponent('d70c4763 ')}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns 400 invalid_code for a leading space', async () => {
    const res = await mount(throwingPrefix(), throwingPrefix()).request(
      `/links/${encodeURIComponent(' d70c4763')}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns 404 not_found when both stores are empty', async () => {
    const res = await mount(
      { listIdsByPrefix: async () => [] },
      { listIdsByPrefix: async () => [] },
    ).request(`/links/${PREFIX}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 200 message for one message id', async () => {
    const res = await mount(
      { listIdsByPrefix: async () => [MESSAGE_ID] },
      { listIdsByPrefix: async () => [] },
    ).request(`/links/${PREFIX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'message', id: MESSAGE_ID });
  });

  it('lowercases a stored uppercase message id', async () => {
    const res = await mount(
      { listIdsByPrefix: async () => [MESSAGE_ID_UPPER] },
      { listIdsByPrefix: async () => [] },
    ).request(`/links/${PREFIX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'message', id: MESSAGE_ID_UPPER.toLowerCase() });
  });

  it('returns 200 message for a soft-hidden row through createApp', async () => {
    const messageStore = new InMemoryMessageStore([
      {
        id: MESSAGE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hidden',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: new Date('2026-09-01T00:00:00.000Z'),
        deletedBy: 'staff',
      },
    ]);
    const app = createApp({ messageStore, authStore: new InMemoryAuthStore() });
    const res = await app.request(`/links/${PREFIX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'message', id: MESSAGE_ID });
  });

  it('returns 200 member for one account id', async () => {
    const res = await mount(
      { listIdsByPrefix: async () => [] },
      { listIdsByPrefix: async () => [ACCOUNT_ID] },
    ).request(`/links/${PREFIX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'member', id: ACCOUNT_ID });
  });

  it('returns 200 member for a real account through createApp', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = createApp({ authStore, messageStore: new InMemoryMessageStore() });
    const res = await app.request(`/links/${PREFIX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'member', id: ACCOUNT_ID });
  });

  it('returns 409 ambiguous for two messages without ids in the body', async () => {
    let accountCalls = 0;
    const res = await mount(
      { listIdsByPrefix: async () => [MESSAGE_ID, OTHER_MESSAGE_ID] },
      {
        listIdsByPrefix: async () => {
          accountCalls += 1;
          return [];
        },
      },
    ).request(`/links/${PREFIX}`);
    expect(accountCalls).toBe(1);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ambiguous' });
  });

  it('returns 409 ambiguous for one message plus one account', async () => {
    const res = await mount(
      { listIdsByPrefix: async () => [MESSAGE_ID] },
      { listIdsByPrefix: async () => [ACCOUNT_ID] },
    ).request(`/links/${PREFIX}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ambiguous' });
  });

  it('resolves an uppercase path param the same as lowercase', async () => {
    const prefixes: string[] = [];
    const res = await mount(
      {
        listIdsByPrefix: async (prefix) => {
          prefixes.push(prefix);
          return [MESSAGE_ID];
        },
      },
      { listIdsByPrefix: async () => [] },
    ).request('/links/D70C4763');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'message', id: MESSAGE_ID });
    expect(prefixes).toEqual([PREFIX]);
  });
});
