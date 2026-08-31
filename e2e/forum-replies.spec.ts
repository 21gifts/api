import { expect, test } from '@playwright/test';

const DEBUG = { authorization: 'Bearer e2e-debug-token' };

test.describe.configure({ mode: 'serial' });

test('e2e: forum note, public read, reply, and replyCount against the booted API', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: `E2eAda${stamp.slice(0, 8)}`,
          lightningAddress: `e2e-ada-${stamp}@walletofsatoshi.com`,
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);

  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const ada = accounts.find((row) => row.name.startsWith('E2eAda'));
  expect(ada).toBeDefined();

  const session = await request.post(`/debug/accounts/${ada?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };

  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'e2e parent note' },
  });
  expect(posted.status()).toBe(200);
  const note = (await posted.json()) as { id: string; text: string; replyCount?: number };
  expect(note.text).toBe('e2e parent note');

  const publicRead = await request.get(`/messages/${note.id}`);
  expect(publicRead.status()).toBe(200);
  expect(((await publicRead.json()) as { text: string }).text).toBe('e2e parent note');

  const reply = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'e2e reply', inReplyTo: note.id },
  });
  expect(reply.status()).toBe(200);
  expect(((await reply.json()) as { text: string }).text).toBe('e2e reply');

  const replies = await request.get(`/messages/${note.id}/replies`, { headers: auth });
  expect(replies.status()).toBe(200);
  const body = (await replies.json()) as { messages: Array<{ text: string }> };
  expect(body.messages.map((row) => row.text)).toEqual(['e2e reply']);
  expect(body).not.toHaveProperty('replies');

  const list = await request.get('/messages', { headers: auth });
  expect(list.status()).toBe(200);
  const listedNotes = (
    (await list.json()) as { messages: Array<{ id: string; replyCount?: number }> }
  ).messages;
  expect(listedNotes.find((row) => row.id === note.id)?.replyCount).toBe(1);
});

test('Function: issueSession — POST /debug/accounts/:id/session with the e2e token is 200', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: `E2eSess${stamp.slice(0, 8)}`,
          lightningAddress: `e2e-sess-${stamp}@walletofsatoshi.com`,
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name.startsWith('E2eSess'));
  expect(row).toBeDefined();
  const session = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const me = await request.get('/me', { headers: { authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(200);
});
