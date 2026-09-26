import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { BtcMapPush } from '@/lib/btcmap-push';
import { InMemoryOcpPlaceStore } from '@/lib/ocp-place-store';
import { ocpPlacesRoutes } from '@/routes/ocp-places';
import { createApp } from '@/server';

const TOKEN = 'ingest-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const BODY = {
  origin: 'partner',
  externalId: 'ext-1',
  name: 'Cafe',
  lat: 47.3,
  lon: 8.5,
  category: 'cafe',
  paymentMethods: 'lightning',
};

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mount(
  opts: {
    places?: InMemoryOcpPlaceStore;
    btcMapPush?: BtcMapPush;
    ingestToken?: string;
  } = {},
): Hono {
  return new Hono().route(
    '/ocp',
    ocpPlacesRoutes({
      places: opts.places ?? new InMemoryOcpPlaceStore(),
      ...(opts.ingestToken === undefined ? {} : { ingestToken: opts.ingestToken }),
      ...(opts.btcMapPush === undefined ? {} : { btcMapPush: opts.btcMapPush }),
    }),
  );
}

describe('GET /ocp/places', () => {
  it('createApp forwards an ingest token and a BTC Map push', async () => {
    const app = createApp({
      ocpPlaceIngestToken: 'tok',
      btcMapPush: {
        submit: () => Promise.resolve('sent'),
      },
    });
    const res = await app.request('/ocp/places');
    expect(res.status).toBe(200);
  });

  it('returns 200 with public fields only and default limit 1000', async () => {
    const places = new InMemoryOcpPlaceStore();
    const created = await places.insertIfNew(BODY);
    const res = await mount({ places }).request('/ocp/places');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(json.places).toHaveLength(1);
    expect(json.places[0]).toEqual({
      id: created.place.id,
      origin: 'partner',
      name: 'Cafe',
      lat: 47.3,
      lon: 8.5,
      category: 'cafe',
    });
    expect(json.places[0]).not.toHaveProperty('externalId');
    expect(json.places[0]).not.toHaveProperty('paymentMethods');
  });

  it('returns 400 for an invalid limit', async () => {
    expect((await mount().request('/ocp/places?limit=0')).status).toBe(400);
    expect(await (await mount().request('/ocp/places?limit=0')).json()).toEqual({
      error: 'Invalid limit',
    });
    expect((await mount().request('/ocp/places?limit=1001')).status).toBe(400);
    expect((await mount().request('/ocp/places?limit=abc')).status).toBe(400);
  });

  it('honors a valid limit', async () => {
    const places = new InMemoryOcpPlaceStore();
    await places.insertIfNew(BODY);
    await places.insertIfNew({ ...BODY, externalId: 'ext-2' });
    const res = await mount({ places }).request('/ocp/places?limit=1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { places: unknown[] }).places).toHaveLength(1);
  });

  it('returns 503 when list throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const places = {
      insertIfNew: async () => {
        throw new Error('unused');
      },
      list: async () => {
        throw new Error('boom');
      },
    };
    const res = await new Hono().route('/ocp', ocpPlacesRoutes({ places })).request('/ocp/places');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Places are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'ocp.place.failed')).toBe(true);
    warn.mockRestore();
  });
});

describe('POST /ocp/places', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when ingest is not configured', async () => {
    const res = await mount().request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Place ingest is not configured' });

    const blank = await mount({ ingestToken: '  ' }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(blank.status).toBe(503);
  });

  it('returns 401 when the Bearer token is missing or wrong', async () => {
    const missing = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });

    const wrong = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { authorization: 'Bearer other', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(wrong.status).toBe(401);

    const sameLength = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { authorization: 'Bearer ingest-secreX', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(sameLength.status).toBe(401);

    const lengthMismatch = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(lengthMismatch.status).toBe(401);
  });

  it('returns 400 for invalid JSON or normalize failures', async () => {
    const badJson = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      error: 'Place must be a latitude and longitude',
    });

    const badOrigin = await mount({ ingestToken: TOKEN }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, origin: 'BAD' }),
    });
    expect(badOrigin.status).toBe(400);
    expect(await badOrigin.json()).toEqual({ error: 'Place origin is invalid' });
  });

  it('returns 201 with btcmap sent, skipped, or failed', async () => {
    const places = new InMemoryOcpPlaceStore();
    const submit = vi.fn<BtcMapPush['submit']>().mockResolvedValue('sent');
    const created = await mount({
      places,
      ingestToken: TOKEN,
      btcMapPush: { submit },
    }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      created: boolean;
      id: string;
      btcmap: string;
    };
    expect(createdBody).toEqual({
      created: true,
      id: createdBody.id,
      btcmap: 'sent',
    });
    expect(submit).toHaveBeenCalledTimes(1);

    const skippedPush = await mount({
      places: new InMemoryOcpPlaceStore(),
      ingestToken: TOKEN,
    }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, externalId: 'ext-2' }),
    });
    expect(skippedPush.status).toBe(201);
    expect(await skippedPush.json()).toMatchObject({ created: true, btcmap: 'skipped' });

    submit.mockResolvedValueOnce('failed');
    const failed = await mount({
      places: new InMemoryOcpPlaceStore(),
      ingestToken: TOKEN,
      btcMapPush: { submit },
    }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, externalId: 'ext-3' }),
    });
    expect(failed.status).toBe(201);
    expect(await failed.json()).toMatchObject({ created: true, btcmap: 'failed' });
  });

  it('returns 200 skipped without calling BTC Map on duplicate', async () => {
    const places = new InMemoryOcpPlaceStore();
    await places.insertIfNew(BODY);
    const submit = vi.fn<BtcMapPush['submit']>().mockResolvedValue('sent');
    const res = await mount({
      places,
      ingestToken: TOKEN,
      btcMapPush: { submit },
    }).request('/ocp/places', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, name: 'Other', lat: 1, lon: 2 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, btcmap: 'skipped' });
    expect(submit).not.toHaveBeenCalled();
    expect((await places.list(10))[0]?.name).toBe('Cafe');
  });

  it('returns 503 when the store throws', async () => {
    const places = {
      insertIfNew: async () => {
        throw new Error('boom');
      },
      list: async () => [],
    };
    const res = await new Hono()
      .route('/ocp', ocpPlacesRoutes({ places, ingestToken: TOKEN }))
      .request('/ocp/places', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(BODY),
      });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Places are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'ocp.place.failed')).toBe(true);
  });
});
