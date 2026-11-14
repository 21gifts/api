import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  OPERATOR_CHALLENGE_TTL_MS,
  OPERATOR_TOKEN_TTL_MS,
  OperatorLogin,
  type OperatorLoginDeps,
} from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';
import { OperatorSigners, loadOperatorSigners } from '@/lib/operator-signers';
import {
  TestKeyring,
  signerLine,
  sshSign,
  type TestKey,
} from '@/__tests__/helpers/ssh-operator-keys';

const NS = '21gifts-debug-dev';
const ring = new TestKeyring();
const alice = ring.key('alice');
const bob = ring.key('bob');
const carol = ring.key('carol');
const dave = ring.key('dave');
const mallory = ring.key('mallory');
const ecdsa = ring.key('ecdsa', 'ecdsa');

/** `YYYYMMDDHHMM` + `Z` for an instant. */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12) + 'Z';
}

const DAVE_VALID_BEFORE = Math.ceil((Date.now() + 10 * 60_000) / 60_000) * 60_000;

const DIR = ring.signersDir({
  read: [
    signerLine('bob', bob),
    signerLine('carol', carol, 'valid-before="20200101"'),
    signerLine('dave', dave, `valid-before="${utcStamp(DAVE_VALID_BEFORE)}"`),
    signerLine('ecdsa-user', ecdsa),
  ],
  write: [signerLine('alice', alice, `namespaces="${NS}"`)],
  admin: [signerLine('bob', bob)],
});

let warn: MockInstance<(...args: unknown[]) => void>;
let clock = Date.now();

beforeEach(() => {
  clock = Date.now();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

afterAll(() => {
  ring.dispose();
});

function signers(dir = DIR): OperatorSigners {
  const loaded = loadOperatorSigners({
    DEBUG_ALLOWED_SIGNERS_DIR: dir,
    DEBUG_SIGNING_NAMESPACE: NS,
  });
  if (loaded === null) {
    throw new Error('signers did not load');
  }
  return loaded;
}

function makeLogin(overrides: Partial<OperatorLoginDeps> = {}): OperatorLogin {
  return new OperatorLogin({
    signers: signers(),
    store: new InMemoryOperatorLoginStore(),
    now: () => clock,
    ...overrides,
  });
}

/** Issue a challenge, sign it with `key` in `namespace`, and log in. */
async function signIn(login: OperatorLogin, key: TestKey, namespace = NS) {
  const { challenge } = await login.issueChallenge();
  return login.login(challenge, sshSign(key, namespace, challenge));
}

/** Every logged line with its fields. */
function logged(): Record<string, unknown>[] {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function lastAttempt(): Record<string, unknown> | undefined {
  return logged()
    .filter((e) => String(e['event']).startsWith('debug.auth.login.'))
    .at(-1);
}

/** A fake `ssh-keygen` script in the keyring directory. */
function fakeKeygen(name: string, body: string): string {
  const path = join(ring.dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function armored(bytes: Uint8Array | string): string {
  const body = Buffer.from(bytes).toString('base64');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
}

function sshString(bytes: Uint8Array | string): Buffer {
  const value = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const VERSION = Buffer.from([0, 0, 0, 1]);

describe('OperatorLogin', () => {
  it('logs in with a listed key and accepts the token at its level', async () => {
    const login = makeLogin();
    expect(login.configured).toBe(true);
    const { challenge, expiresAt } = await login.issueChallenge();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(clock + OPERATOR_CHALLENGE_TTL_MS);
    const signature = sshSign(alice, NS, challenge);
    const result = await login.login(challenge, signature);
    expect(result).toEqual({
      ok: true,
      token: expect.stringMatching(/^op_[A-Za-z0-9_-]{43}$/),
      grant: { operator: 'alice', keyFingerprint: alice.fingerprint, level: 'write' },
      expiresAt: clock + OPERATOR_TOKEN_TTL_MS,
    });
    if (!result.ok) {
      return;
    }
    expect(await login.resolveBearer(`Bearer ${result.token}`)).toEqual(result.grant);
    expect(lastAttempt()).toEqual(
      expect.objectContaining({
        event: 'debug.auth.login.ok',
        operator: 'alice',
        keyFingerprint: alice.fingerprint,
        level: 'write',
      }),
    );
    const text = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).not.toContain(result.token);
    expect(text).not.toContain(challenge);
    expect(text).not.toContain(signature.split('\n')[1] ?? 'unused');
  });

  it('refuses an unknown key', async () => {
    expect(await signIn(makeLogin(), mallory)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(lastAttempt()).toEqual({
      ts: expect.any(String),
      event: 'debug.auth.login.refused',
      reason: 'unknown_key',
      keyFingerprint: mallory.fingerprint,
    });
  });

  it("refuses a signature made for another environment's namespace", async () => {
    expect(await signIn(makeLogin(), alice, '21gifts-debug-prd')).toEqual({
      ok: false,
      reason: 'verify',
    });
    expect(lastAttempt()).toEqual(expect.objectContaining({ reason: 'verify', operator: 'alice' }));
    // A line without `namespaces` still only verifies in this api's namespace.
    expect(await signIn(makeLogin(), bob, '21gifts-debug-stg')).toEqual({
      ok: false,
      reason: 'verify',
    });
  });

  it('refuses a listed key that is not ssh-ed25519 before any process starts', async () => {
    const login = makeLogin({ sshKeygenPath: '/nonexistent/ssh-keygen' });
    expect(await signIn(login, ecdsa)).toEqual({ ok: false, reason: 'key_type' });
    expect(lastAttempt()).toEqual(
      expect.objectContaining({ reason: 'key_type', keyFingerprint: ecdsa.fingerprint }),
    );
  });

  it('refuses a replayed challenge', async () => {
    const login = makeLogin();
    const { challenge } = await login.issueChallenge();
    const signature = sshSign(alice, NS, challenge);
    expect((await login.login(challenge, signature)).ok).toBe(true);
    expect(await login.login(challenge, signature)).toEqual({ ok: false, reason: 'challenge' });
  });

  it('refuses an expired, unknown, or malformed challenge before any process starts', async () => {
    const login = makeLogin({ sshKeygenPath: '/nonexistent/ssh-keygen' });
    const { challenge } = await login.issueChallenge();
    const signature = sshSign(alice, NS, challenge);
    clock += OPERATOR_CHALLENGE_TTL_MS;
    expect(await login.login(challenge, signature)).toEqual({ ok: false, reason: 'challenge' });
    expect(await login.login('A'.repeat(43), signature)).toEqual({
      ok: false,
      reason: 'challenge',
    });
    expect(await login.login('not a challenge', signature)).toEqual({
      ok: false,
      reason: 'challenge',
    });
  });

  it('refuses a signature over a different challenge', async () => {
    const login = makeLogin();
    const first = await login.issueChallenge();
    const second = await login.issueChallenge();
    expect(await login.login(second.challenge, sshSign(alice, NS, first.challenge))).toEqual({
      ok: false,
      reason: 'verify',
    });
  });

  it('refuses a token after 15 minutes', async () => {
    const login = makeLogin();
    const result = await signIn(login, alice);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    clock += OPERATOR_TOKEN_TTL_MS - 1;
    expect(await login.resolveBearer(`Bearer ${result.token}`)).not.toBeNull();
    clock += 1;
    expect(await login.resolveBearer(`Bearer ${result.token}`)).toBeNull();
  });

  it('grants a key listed in two files the higher level', async () => {
    const result = await signIn(makeLogin(), bob);
    expect(result.ok && result.grant.level).toBe('admin');
  });

  it('grants only the level of lines whose namespaces include this api', async () => {
    const split = ring.signersDir({
      read: [signerLine('alice', alice)],
      write: [],
      admin: [signerLine('alice', alice, 'namespaces="21gifts-debug-prd"')],
    });
    const store = new InMemoryOperatorLoginStore();
    const login = makeLogin({ store, signers: signers(split) });
    const result = await signIn(login, alice);
    expect(result.ok && result.grant.level).toBe('read');
    if (!result.ok) {
      return;
    }
    expect((await login.resolveBearer(`Bearer ${result.token}`))?.level).toBe('read');
  });

  it('refuses a key past valid-before at login and on later requests', async () => {
    expect(await signIn(makeLogin(), carol)).toEqual({ ok: false, reason: 'unknown_key' });
    const login = makeLogin();
    const result = await signIn(login, dave);
    expect(result.ok && result.grant.level).toBe('read');
    if (!result.ok) {
      return;
    }
    clock = DAVE_VALID_BEFORE - 1;
    expect(await login.resolveBearer(`Bearer ${result.token}`)).not.toBeNull();
    clock = DAVE_VALID_BEFORE;
    expect(await login.resolveBearer(`Bearer ${result.token}`)).toBeNull();
  });

  it('refuses the token of an operator removed from the files or moved to a lower level', async () => {
    const store = new InMemoryOperatorLoginStore();
    const result = await signIn(makeLogin({ store }), alice);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const bearer = `Bearer ${result.token}`;
    const removed = ring.signersDir({ read: [signerLine('bob', bob)], write: [], admin: [] });
    expect(await makeLogin({ store, signers: signers(removed) }).resolveBearer(bearer)).toBeNull();
    const lowered = ring.signersDir({ read: [signerLine('alice', alice)], write: [], admin: [] });
    expect(await makeLogin({ store, signers: signers(lowered) }).resolveBearer(bearer)).toBeNull();
    const otherKey = ring.signersDir({ read: [], write: [signerLine('alice', bob)], admin: [] });
    expect(await makeLogin({ store, signers: signers(otherKey) }).resolveBearer(bearer)).toBeNull();
    expect(await makeLogin({ store }).resolveBearer(bearer)).not.toBeNull();
  });

  it('logs in as the one principal ssh-keygen names for a key two lines share', async () => {
    const shared = ring.signersDir({
      read: [signerLine('alice', alice), signerLine('alice2', alice)],
      write: [],
      admin: [],
    });
    const result = await signIn(makeLogin({ signers: signers(shared) }), alice);
    expect(result.ok && result.grant).toEqual({
      operator: 'alice',
      keyFingerprint: alice.fingerprint,
      level: 'read',
    });
  });

  it('refuses unless find-principals names exactly one principal', async () => {
    for (const body of ['exit 0', 'printf "alice\\nbob\\n"', 'echo alice; exit 1']) {
      const login = makeLogin({ sshKeygenPath: fakeKeygen('principals-keygen', body) });
      expect([body, await signIn(login, alice)]).toEqual([
        body,
        { ok: false, reason: 'unknown_key' },
      ]);
    }
  });

  it('refuses a verified signature whose key no line grants now', async () => {
    const line = signerLine('alice', alice);
    const mismatched = new OperatorSigners(NS, [
      { principal: 'alice', level: 'admin', fingerprint: 'SHA256:other', validBefore: null, line },
    ]);
    expect(await signIn(makeLogin({ signers: mismatched }), alice)).toEqual({
      ok: false,
      reason: 'not_listed',
    });
  });

  it('refuses malformed signatures before any process starts', async () => {
    const login = makeLogin({ sshKeygenPath: '/nonexistent/ssh-keygen' });
    const cases = [
      'garbage',
      '-----BEGIN SSH SIGNATURE-----\n*not base64*\n-----END SSH SIGNATURE-----',
      armored('NOTSIG\0\0\0\x01'),
      armored('SSHSIG\0\0'),
      armored(Buffer.concat([Buffer.from('SSHSIG'), VERSION])),
      armored(Buffer.concat([Buffer.from('SSHSIG'), VERSION, Buffer.from([0, 0, 0, 99, 1])])),
    ];
    for (const signature of cases) {
      const { challenge } = await login.issueChallenge();
      expect([signature, await login.login(challenge, signature)]).toEqual([
        signature,
        { ok: false, reason: 'signature' },
      ]);
    }
    const { challenge } = await login.issueChallenge();
    const emptyKey = armored(Buffer.concat([Buffer.from('SSHSIG'), VERSION, sshString('')]));
    expect(await login.login(challenge, emptyKey)).toEqual({ ok: false, reason: 'key_type' });
  });

  it('kills an ssh-keygen run that passes the time limit', async () => {
    const login = makeLogin({
      sshKeygenPath: fakeKeygen('slow-keygen', 'exec sleep 5'),
      sshKeygenTimeoutMs: 100,
    });
    expect(await signIn(login, alice)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses when ssh-keygen cannot be started', async () => {
    const login = makeLogin({ sshKeygenPath: join(ring.dir, 'missing-keygen') });
    expect(await signIn(login, alice)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('keeps at most 16 KiB of ssh-keygen output', async () => {
    const login = makeLogin({
      sshKeygenPath: fakeKeygen('loud-keygen', "head -c 40000 /dev/zero | tr '\\000' a"),
    });
    expect(await signIn(login, alice)).toEqual({ ok: false, reason: 'not_listed' });
    expect(lastAttempt()?.['operator']).toBe('a'.repeat(16_384));
  });

  it('runs ssh-keygen without PATH in the environment', async () => {
    const path = execFileSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).trim();
    const saved = process.env['PATH'];
    delete process.env['PATH'];
    try {
      expect((await signIn(makeLogin({ sshKeygenPath: path }), alice)).ok).toBe(true);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('removes its temporary directory in every outcome', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('operator-login-'));
    await signIn(makeLogin(), alice);
    await signIn(makeLogin(), mallory);
    await signIn(makeLogin({ sshKeygenPath: join(ring.dir, 'missing-keygen') }), alice);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('operator-login-'));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });

  it('deletes expired challenges and tokens on every challenge and login', async () => {
    const store = new InMemoryOperatorLoginStore();
    const deleteExpired = vi.spyOn(store, 'deleteExpired');
    const login = makeLogin({ store });
    await signIn(login, alice);
    expect(deleteExpired.mock.calls).toEqual([[clock], [clock]]);
  });

  it('ignores bearers that are not key tokens', async () => {
    const login = makeLogin();
    expect(await login.resolveBearer(undefined)).toBeNull();
    expect(await login.resolveBearer('Basic x')).toBeNull();
    expect(await login.resolveBearer(`Bearer ${'a'.repeat(64)}`)).toBeNull();
    expect(await login.resolveBearer(`Bearer op_${'a'.repeat(43)}`)).toBeNull();
  });

  it('is off without loaded signers', async () => {
    const login = makeLogin({ signers: null });
    expect(login.configured).toBe(false);
    expect(await login.resolveBearer(`Bearer op_${'a'.repeat(43)}`)).toBeNull();
    await expect(login.issueChallenge()).rejects.toThrow('Operator key login is not configured');
    await expect(login.login('a', 'b')).rejects.toThrow('Operator key login is not configured');
  });
});
