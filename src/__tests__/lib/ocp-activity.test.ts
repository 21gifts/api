import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  logActivityFailure,
  pingShopActivity,
  resolveActivityPing,
  type ActivityPing,
} from '@/lib/ocp-activity';
import type { MapFetch } from '@/lib/ocp-place';

const OCCURRED_AT = '2023-11-14T22:13:20.000Z';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

type RecordedCall = {
  url: string;
  method: string;
  authorization: string;
  contentType: string;
  body: string;
};

function recordingPing(status = 200): { ping: ActivityPing; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: MapFetch = async (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
      contentType: headers.get('content-type') ?? '',
      body: String(init.body),
    });
    return new Response('{}', { status });
  };
  return {
    ping: { baseUrl: 'http://map.test', token: 'secret', fetchImpl },
    calls,
  };
}

describe('resolveActivityPing', () => {
  it('returns undefined for a missing or whitespace URL or token', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(resolveActivityPing({}, fetchImpl)).toBeUndefined();
    expect(
      resolveActivityPing({ OCP_MAP_BASE_URL: '  ', OCP_PLACE_INGEST_TOKEN: 'secret' }, fetchImpl),
    ).toBeUndefined();
    expect(resolveActivityPing({ OCP_MAP_BASE_URL: 'http://map.test' }, fetchImpl)).toBeUndefined();
    expect(
      resolveActivityPing(
        { OCP_MAP_BASE_URL: 'http://map.test', OCP_PLACE_INGEST_TOKEN: ' ' },
        fetchImpl,
      ),
    ).toBeUndefined();
  });

  it('returns the trimmed url and token when both are set', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(
      resolveActivityPing(
        { OCP_MAP_BASE_URL: ' http://map.test/// ', OCP_PLACE_INGEST_TOKEN: ' secret ' },
        fetchImpl,
      ),
    ).toMatchObject({ baseUrl: 'http://map.test', token: 'secret', fetchImpl });
  });
});

describe('pingShopActivity', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('does not fetch when ping is undefined', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(pingShopActivity(undefined, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips empty ids and duplicates while keeping first-occurrence order', async () => {
    const { ping, calls } = recordingPing();
    await pingShopActivity(ping, [], OCCURRED_AT);
    await pingShopActivity(ping, [''], OCCURRED_AT);
    await pingShopActivity(ping, ['a', '', 'a', 'b'], OCCURRED_AT);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ externalId: 'a' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ externalId: 'b' });
  });

  it('posts one id with the transactions body and a 5s timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { ping, calls } = recordingPing();
    await pingShopActivity(ping, ['shop-1'], OCCURRED_AT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places/transactions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      origin: '21gifts',
      externalId: 'shop-1',
      occurredAt: OCCURRED_AT,
    });
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed')).toHaveLength(0);
    timeoutSpy.mockRestore();
  });

  it('logs ocp.activity.failed with numeric status on HTTP 404 and still resolves', async () => {
    const { ping } = recordingPing(404);
    await expect(pingShopActivity(ping, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['status']).toBe(404);
    expect(Object.keys(failed[0] ?? {}).filter((key) => key !== 'ts' && key !== 'event')).toEqual([
      'status',
    ]);
  });

  it('attempts the second id after the first fetch throws', async () => {
    const calls: RecordedCall[] = [];
    let n = 0;
    const fetchImpl: MapFetch = async (input, init) => {
      n += 1;
      const headers = new Headers(init.headers);
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        authorization: headers.get('authorization') ?? '',
        contentType: headers.get('content-type') ?? '',
        body: String(init.body),
      });
      if (n === 1) {
        throw new Error('first-hidden');
      }
      return new Response('{}', { status: 200 });
    };
    await expect(
      pingShopActivity(
        { baseUrl: 'http://map.test', token: 'secret', fetchImpl },
        ['a', 'b'],
        OCCURRED_AT,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ externalId: 'a' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ externalId: 'b' });
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('first-hidden');
  });

  it('logs ocp.activity.failed without the message or address', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('down'), { address: 'addr-must-not-appear' });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]).not.toHaveProperty('address');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('down');
    expect(warned).not.toContain('addr-must-not-appear');
  });

  it('logs ocp.activity.failed with the syscall code from cause', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['code']).toBe('ECONNREFUSED');
    expect(failed[0]?.['name']).toBe('TypeError');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('fetch failed');
    expect(warned).not.toContain('connect');
  });

  it('logs ocp.activity.failed with the outer code, not the cause code', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          code: 'EPIPE',
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['code']).toBe('EPIPE');
    expect(failed[0]?.['name']).toBe('TypeError');
    expect(Object.values(failed[0] ?? {})).not.toContain('ECONNREFUSED');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('ECONNREFUSED');
    expect(warned).not.toContain('fetch failed');
    expect(warned).not.toContain('connect');
  });

  it('logs ocp.activity.failed with the outer errno when outer has no code', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('outer-hidden'), {
          errno: 'EAGAIN',
          cause: Object.assign(new Error('inner-hidden'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['errno']).toBe('EAGAIN');
    expect(failed[0]?.['code']).not.toBe('ECONNREFUSED');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('outer-hidden');
    expect(warned).not.toContain('inner-hidden');
    expect(warned).not.toContain('ECONNREFUSED');
  });

  it('logs the bare ocp.activity.failed event for a non-Error throw', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw 'token-must-not-appear';
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBeUndefined();
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('token-must-not-appear');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
  });

  it('does not treat a null cause as a syscall cause', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('null-cause-hidden'), { cause: null });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('null-cause-hidden');
  });

  it('logs ocp.activity.failed with the cause errno when the cause has no code', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('errno-hidden'), {
          cause: { errno: 'ENOENT' },
        });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['errno']).toBe('ENOENT');
    expect(failed[0]?.['code']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('errno-hidden');
  });

  it('logs ocp.activity.failed without code or errno when the cause has neither', async () => {
    const throwing: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('outer-plain'), {
          cause: new Error('cause-plain'),
        });
      },
    };
    await expect(pingShopActivity(throwing, ['shop-1'], OCCURRED_AT)).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('http://map.test');
    expect(warned).not.toContain('outer-plain');
    expect(warned).not.toContain('cause-plain');
  });
});

describe('logActivityFailure', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('logs the bare event when nothing is allowlisted', () => {
    logActivityFailure('token-must-not-appear');
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0] ?? {}).filter((key) => key !== 'ts' && key !== 'event')).toEqual(
      [],
    );
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('token-must-not-appear');
  });
});
