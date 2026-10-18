const AUTHORIZATION = 'Bearer e2e-ocp-token';

type MapMethod = 'PUT' | 'DELETE';

type RecordedCall = {
  method: MapMethod;
  body: Record<string, unknown>;
};

type AuthorizedCall = {
  method: MapMethod;
  body: unknown;
  timestamp: string;
};

const calls = new Map<string, RecordedCall[]>();
const authorizedCalls: AuthorizedCall[] = [];
const bootCalls: AuthorizedCall[] = [];
const places = new Set<string>();
let bootClosed = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function placeKey(body: Record<string, unknown>): string | null {
  const origin = body['origin'];
  const externalId = body['externalId'];
  if (typeof origin !== 'string' || typeof externalId !== 'string') {
    return null;
  }
  return `${origin}:${externalId}`;
}

Bun.serve({
  hostname: '127.0.0.1',
  port: 3099,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/_calls') {
      bootClosed = true;
      const externalId = url.searchParams.get('externalId');
      return Response.json(externalId === null ? authorizedCalls : (calls.get(externalId) ?? []));
    }
    if (request.method === 'GET' && url.pathname === '/_boot') {
      bootClosed = true;
      return Response.json(bootCalls);
    }
    if (
      url.pathname !== '/map/places' ||
      (request.method !== 'PUT' && request.method !== 'DELETE')
    ) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (request.headers.get('authorization') !== AUTHORIZATION) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const method: MapMethod = request.method === 'PUT' ? 'PUT' : 'DELETE';
    const authorizedCall: AuthorizedCall = {
      method,
      body: null,
      timestamp: new Date().toISOString(),
    };
    authorizedCalls.push(authorizedCall);
    if (!bootClosed) {
      bootCalls.push(authorizedCall);
    }
    const parsed: unknown = await request.json().catch(() => null);
    authorizedCall.body = parsed;
    if (!isRecord(parsed)) {
      return Response.json({ error: 'Invalid body' }, { status: 400 });
    }
    const key = placeKey(parsed);
    const externalId = parsed['externalId'];
    if (key === null || typeof externalId !== 'string') {
      return Response.json({ error: 'Invalid body' }, { status: 400 });
    }
    const recorded = calls.get(externalId) ?? [];
    recorded.push({ method, body: parsed });
    calls.set(externalId, recorded);

    if (method === 'PUT') {
      const created = !places.has(key);
      places.add(key);
      return Response.json(
        { created, id: 'stub', btcmap: 'skipped' },
        { status: created ? 201 : 200 },
      );
    }
    return Response.json({ deleted: places.delete(key) });
  },
});
