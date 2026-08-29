import { describe, it, expect } from 'vitest';
import { serializeContact, serializeDebugContact, type ContactRow } from '@/lib/contact';

const ROW: ContactRow = {
  id: 'c-1',
  accountId: 'acc-1',
  name: 'Ada',
  text: 'hello',
  createdAt: new Date('2026-08-29T12:00:00.000Z'),
};

describe('serializeContact', () => {
  it('emits ISO createdAt and omits accountId', () => {
    expect(serializeContact(ROW)).toEqual({
      id: 'c-1',
      name: 'Ada',
      text: 'hello',
      createdAt: '2026-08-29T12:00:00.000Z',
    });
    expect(serializeContact(ROW)).not.toHaveProperty('accountId');
  });
});

describe('serializeDebugContact', () => {
  it('emits ISO createdAt and includes accountId', () => {
    expect(serializeDebugContact(ROW)).toEqual({
      id: 'c-1',
      accountId: 'acc-1',
      name: 'Ada',
      text: 'hello',
      createdAt: '2026-08-29T12:00:00.000Z',
    });
  });
});
