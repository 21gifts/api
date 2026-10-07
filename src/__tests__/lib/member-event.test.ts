import { describe, expect, it } from 'vitest';
import { encodeSparkInvoice } from '@/lib/spark-invoice';
import {
  MEMBER_EVENT_BATCH_MAX,
  MEMBER_EVENT_NAMES,
  MEMBER_EVENT_PROPS_MAX,
  parseMemberEventBatch,
} from '@/lib/member-event';

const NOW = 1_700_000_000_000;
const AT = '2023-11-14T22:13:19.000Z';
const AT_MS = Date.parse(AT);
const PHRASE_12 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';
const NSEC1 = 'nsec1abcdefghijklmnopqrstuvwxyz123456';

function parse(body: unknown): ReturnType<typeof parseMemberEventBatch> {
  return parseMemberEventBatch(body, NOW);
}

function event(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'login', at: AT, ...partial };
}

describe('MEMBER_EVENT_NAMES', () => {
  it('is the exact allow-list', () => {
    expect([...MEMBER_EVENT_NAMES].sort()).toEqual(
      [
        'gift_sent',
        'login',
        'payment_received_seen',
        'payment_sent',
        'pos_charge_created',
        'pos_charge_paid_seen',
        'post_created',
        'profile_opened',
        'reply_created',
        'screen_view',
        'search',
        'shop_opened',
        'signup_completed',
        'wallet_locked',
        'wallet_unlocked',
      ].sort(),
    );
  });
});

describe('parseMemberEventBatch', () => {
  it('rejects a non-object body, a missing events array, and an oversized batch', () => {
    expect(parse(null)).toEqual({ ok: false });
    expect(parse(1)).toEqual({ ok: false });
    expect(parse('x')).toEqual({ ok: false });
    expect(parse([])).toEqual({ ok: false });
    expect(parse({})).toEqual({ ok: false });
    expect(parse({ events: {} })).toEqual({ ok: false });
    expect(parse({ events: null })).toEqual({ ok: false });
    const tooMany = Array.from({ length: MEMBER_EVENT_BATCH_MAX + 1 }, () => event());
    expect(parse({ events: tooMany })).toEqual({ ok: false });
  });

  it('accepts an empty batch and a full batch of 50', () => {
    expect(parse({ events: [] })).toEqual({ ok: true, events: [], dropped: 0 });
    const full = Array.from({ length: MEMBER_EVENT_BATCH_MAX }, () => event());
    const result = parse({ events: full });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.events).toHaveLength(MEMBER_EVENT_BATCH_MAX);
    expect(result.dropped).toBe(0);
  });

  it.each([...MEMBER_EVENT_NAMES])('accepts allow-listed name %s', (name) => {
    const result = parse({ events: [event({ name })] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.events[0]?.name).toBe(name);
    expect(result.dropped).toBe(0);
  });

  it('drops entries that are not plain objects or have a bad name or at', () => {
    const result = parse({
      events: [
        null,
        [],
        'login',
        1,
        event({ name: 1 }),
        event({ name: 'not_an_event' }),
        event({ at: 'nope' }),
        event({ at: null }),
        event({ at: NOW + 1_000_000 }),
        event(),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(9);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.at.getTime()).toBe(AT_MS);
  });

  it('treats omitted and null path as null and strips query or fragment', () => {
    const result = parse({
      events: [
        event(),
        event({ path: null }),
        event({ path: '/home?x=1#y' }),
        event({ path: '/a#b?c' }),
        event({ path: '/only-query?z=1' }),
        event({ path: '/only-hash#z' }),
        event({ path: '/' }),
        event({ path: `/${'a'.repeat(255)}` }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(0);
    expect(result.events.map((item) => item.path)).toEqual([
      null,
      null,
      '/home',
      '/a',
      '/only-query',
      '/only-hash',
      '/',
      `/${'a'.repeat(255)}`,
    ]);
  });

  it('drops events with a non-string, invalid, or secret-shaped path', () => {
    const result = parse({
      events: [
        event({ path: 1 }),
        event({ path: true }),
        event({ path: {} }),
        event({ path: [] }),
        event({ path: '' }),
        event({ path: 'relative' }),
        event({ path: '?only' }),
        event({ path: '#only' }),
        event({ path: `/${'a'.repeat(256)}` }),
        event({ path: '/ok\t' }),
        event({ path: '/ok\u007f' }),
        event({ path: `/u/${NSEC1}` }),
        event({ path: `/u/${encodeURIComponent(PHRASE_12)}` }),
        event({ path: `/${PHRASE_12.split(' ').join('/')}` }),
        event({ path: `/wallet/${PHRASE_12.split(' ').join('/')}` }),
        event({ path: `/${PHRASE_12.split(' ').join('/')}/done` }),
        event({ path: `/a/${encodeURIComponent(PHRASE_12)}/b` }),
        event({ path: '/bad%E0%A4%A' }),
        event({ path: '/ok' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(17);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.path).toBe('/bad%E0%A4%A');
    expect(result.events[1]?.path).toBe('/ok');
  });

  it('drops a path and skips a prop that carry a phrase inside a Spark invoice memo', () => {
    const encoded = encodeSparkInvoice({
      identityPublicKey: `02${'c'.repeat(64)}`,
      id: new Uint8Array(16),
      memo: PHRASE_12,
      amountSats: 21,
    });
    const result = parse({
      events: [event({ path: `/pay/${encoded}` }), event({ props: { target: encoded, n: 1 } })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(1);
    expect(result.events[0]?.props).toEqual({ n: 1 });
  });

  it('decodes each escape on its own, so a malformed escape cannot hide an encoded key', () => {
    const result = parse({
      events: [
        event({ path: '/a%E0%A4%ZZ%20%6Esec1abc' }),
        event({ path: `/a%ZZ%20${encodeURIComponent(PHRASE_12)}` }),
        event({ path: '/a%ZZ%20coffee' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(2);
    expect(result.events.map((row) => row.path)).toEqual(['/a%ZZ%20coffee']);
  });

  it('skips snake_case secret-named props holding raw 32-byte values', () => {
    const raw = 'ab'.repeat(32);
    const result = parse({
      events: [event({ props: { spending_key: raw, priv_key: raw, n_sec: raw, count: 2 } })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.events[0]?.props).toEqual({ count: 2 });
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it('drops a path holding a percent-encoded non-English phrase', () => {
    const japanese =
      'あいこくしん　あいさつ　あいだ　あおぞら　あかちゃん　あきる　あけがた　あける　あこがれる　あさい　あさひ　あしあと';
    const result = parse({
      events: [
        event({ path: `/note/${encodeURIComponent(japanese.normalize('NFKD'))}` }),
        event({ path: `/note/${encodeURIComponent('ありがとう')}` }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(1);
    expect(result.events).toHaveLength(1);
  });

  it('keeps a plain path unchanged', () => {
    const result = parse({ events: [event({ path: '/ok' })] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(0);
    expect(result.events[0]?.path).toBe('/ok');
  });

  it('treats omitted and null props as empty and drops a non-object or oversized props object', () => {
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < MEMBER_EVENT_PROPS_MAX + 1; i += 1) {
      tooMany[`k${i}`] = i;
    }
    const twenty: Record<string, number> = {};
    for (let i = 0; i < MEMBER_EVENT_PROPS_MAX; i += 1) {
      twenty[`k${i}`] = i;
    }
    const result = parse({
      events: [
        event(),
        event({ props: null }),
        event({ props: twenty }),
        event({ props: tooMany }),
        event({ props: [] }),
        event({ props: 'x' }),
        event({ props: 1 }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(4);
    expect(result.events[0]?.props).toEqual({});
    expect(result.events[1]?.props).toEqual({});
    expect(Object.keys(result.events[2]?.props ?? {})).toHaveLength(MEMBER_EVENT_PROPS_MAX);
  });

  it('skips invalid, secret, and non-scalar prop keys without dropping the event', () => {
    const longKey = `A${'x'.repeat(40)}`;
    const okKey = `A${'x'.repeat(39)}`;
    const longString = 'a'.repeat(201);
    const okString = 'a'.repeat(200);
    const result = parse({
      events: [
        event({
          extraEventField: 'ignored',
          props: {
            '1bad': 'x',
            [longKey]: 'x',
            [okKey]: true,
            seed: 'x',
            preimage: 'x',
            privateKey: 'x',
            keepNull: null,
            keepBool: false,
            keepNum: 1.5,
            keepZero: 0,
            skipNaN: Number.NaN,
            skipInf: Number.POSITIVE_INFINITY,
            skipObj: { x: 1 },
            skipArr: [1],
            skipLong: longString,
            skipC0: 'ok\n',
            skipPhrase: PHRASE_12,
            skipNsec: NSEC1,
            keepStr: okString,
            query: 'home',
          },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dropped).toBe(0);
    expect(result.events[0]?.props).toEqual({
      [okKey]: true,
      keepNull: null,
      keepBool: false,
      keepNum: 1.5,
      keepZero: 0,
      keepStr: okString,
      query: 'home',
    });
  });

  it('ignores unknown top-level keys and parses numeric at', () => {
    const result = parse({
      debug: true,
      events: [event({ at: 1_700_000_000, leftover: 1 })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.events[0]?.at.getTime()).toBe(NOW);
    expect(result.events[0]).toEqual({
      name: 'login',
      at: result.events[0]?.at,
      path: null,
      props: {},
    });
  });
});
