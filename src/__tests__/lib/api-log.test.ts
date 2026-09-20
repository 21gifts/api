import { describe, expect, it } from 'vitest';
import {
  InMemoryApiLogStore,
  serializeDebugApiLog,
  type ApiLogRow,
} from '@/lib/api-log';

const EARLY: ApiLogRow = {
  id: 'a',
  createdAt: new Date('2026-09-19T12:00:00.000Z'),
  method: 'GET',
  path: '/info',
  status: 200,
  ms: 1,
  accountId: null,
  authKind: 'none',
};

const LATE: ApiLogRow = {
  id: 'b',
  createdAt: new Date('2026-09-19T13:00:00.000Z'),
  method: 'POST',
  path: '/conversations/x',
  status: 200,
  ms: 4,
  accountId: 'acc',
  authKind: 'session',
};

describe('serializeDebugApiLog', () => {
  it('emits ISO createdAt and the stored fields', () => {
    expect(serializeDebugApiLog(LATE)).toEqual({
      id: 'b',
      createdAt: '2026-09-19T13:00:00.000Z',
      method: 'POST',
      path: '/conversations/x',
      status: 200,
      ms: 4,
      accountId: 'acc',
      authKind: 'session',
    });
  });
});

describe('InMemoryApiLogStore', () => {
  it('lists newest first and copies rows', async () => {
    const store = new InMemoryApiLogStore([EARLY, LATE]);
    const listed = await store.listLatest(10);
    expect(listed.map((row) => row.id)).toEqual(['b', 'a']);
    listed[0]!.path = 'mutated';
    const again = await store.listLatest(10);
    expect(again[0]?.path).toBe('/conversations/x');
  });

  it('appends and caps listLatest', async () => {
    const store = new InMemoryApiLogStore();
    await store.append(EARLY);
    await store.append(LATE);
    expect((await store.listLatest(1)).map((row) => row.id)).toEqual(['b']);
  });
});
