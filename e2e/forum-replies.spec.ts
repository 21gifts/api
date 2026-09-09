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
  const adaName = `E2eAda${stamp.slice(0, 8)}`;
  const ada = accounts.find((row) => row.name === adaName);
  expect(ada).toBeDefined();

  const session = await request.post(`/debug/accounts/${ada?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const agreed = await request.post('/me/rules-agreement', { headers: auth });
  expect(agreed.status()).toBe(200);

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

  await new Promise((resolve) => {
    setTimeout(resolve, 11_000);
  });

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
  const sessName = `E2eSess${stamp.slice(0, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: sessName,
          lightningAddress: `e2e-sess-${stamp}@walletofsatoshi.com`,
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === sessName);
  expect(row).toBeDefined();
  const session = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const me = await request.get('/me', { headers: { authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(200);
});

test('Function: markDeleted — DELETE /messages/:id hides the note', async ({ request }) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const hideName = `E2eHide${stamp.slice(0, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: hideName,
          lightningAddress: `e2e-hide-${stamp}@walletofsatoshi.com`,
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);

  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const account = accounts.find((row) => row.name === hideName);
  expect(account).toBeDefined();

  const session = await request.post(`/debug/accounts/${account?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const agreed = await request.post('/me/rules-agreement', { headers: auth });
  expect(agreed.status()).toBe(200);

  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'e2e hide me' },
  });
  expect(posted.status()).toBe(200);
  const note = (await posted.json()) as { id: string };

  const beforeHide = await request.get(`/messages/${note.id}`);
  expect(beforeHide.status()).toBe(200);

  const basisDenied = await request.delete(`/messages/${note.id}`, { headers: auth });
  expect(basisDenied.status()).toBe(403);
  const stillVisible = await request.get(`/messages/${note.id}`);
  expect(stillVisible.status()).toBe(200);

  const promoted = await request.patch(`/debug/accounts/${account?.id}`, {
    headers: DEBUG,
    data: { role: 'moderator' },
  });
  expect(promoted.status()).toBe(200);

  const hidden = await request.delete(`/messages/${note.id}`, { headers: auth });
  expect(hidden.status()).toBe(204);
  expect(await hidden.text()).toBe('');

  const afterHide = await request.get(`/messages/${note.id}`);
  expect(afterHide.status()).toBe(404);

  const list = await request.get('/messages', { headers: auth });
  expect(list.status()).toBe(200);
  const listedNotes = ((await list.json()) as { messages: Array<{ id: string }> }).messages;
  expect(listedNotes.some((row) => row.id === note.id)).toBe(false);

  const photo = await request.get(`/messages/${note.id}/photo`);
  expect(photo.status()).toBe(404);

  const again = await request.delete(`/messages/${note.id}`, { headers: auth });
  expect(again.status()).toBe(204);
});
