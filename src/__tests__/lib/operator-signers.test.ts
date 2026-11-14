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
  OPERATOR_SIGNER_FILES,
  OperatorSigners,
  loadOperatorSigners,
  sshKeyFingerprint,
} from '@/lib/operator-signers';
import { TestKeyring, signerLine } from '@/__tests__/helpers/ssh-operator-keys';

const NS = '21gifts-debug-dev';
const ring = new TestKeyring();
const alice = ring.key('alice');
const bob = ring.key('bob');
const ecdsa = ring.key('ecdsa', 'ecdsa');
const rsa = ring.key('rsa', 'rsa');

afterAll(() => {
  ring.dispose();
});

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

/** Logged events with their fields. */
function events(): Record<string, unknown>[] {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function load(dir: string, namespace = NS): OperatorSigners | null {
  return loadOperatorSigners({
    DEBUG_ALLOWED_SIGNERS_DIR: dir,
    DEBUG_SIGNING_NAMESPACE: namespace,
  });
}

describe('loadOperatorSigners', () => {
  it('stays off and silent when both settings are unset or blank', () => {
    expect(loadOperatorSigners({})).toBeNull();
    expect(
      loadOperatorSigners({ DEBUG_ALLOWED_SIGNERS_DIR: ' ', DEBUG_SIGNING_NAMESPACE: '' }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays off and logs the reason when one setting is missing or the namespace is not allowed', () => {
    const dir = ring.signersDir({ read: [], write: [], admin: [] });
    expect(loadOperatorSigners({ DEBUG_ALLOWED_SIGNERS_DIR: dir })).toBeNull();
    expect(loadOperatorSigners({ DEBUG_SIGNING_NAMESPACE: NS })).toBeNull();
    expect(load(dir, '21gifts-debug-test')).toBeNull();
    expect(events().map((e) => [e['event'], e['reason']])).toEqual([
      ['debug.auth.signers.off', 'namespace_unset'],
      ['debug.auth.signers.off', 'dir_unset'],
      ['debug.auth.signers.off', 'namespace_invalid'],
    ]);
  });

  it('stays off when one of the three files is missing', () => {
    const dir = ring.signersDir({ read: [], admin: [] });
    expect(load(dir)).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'debug.auth.signers.off',
        reason: 'unreadable',
        level: 'write',
      }),
    ]);
  });

  it('accepts each of the three environments', () => {
    const dir = ring.signersDir({ read: [], write: [], admin: [] });
    for (const env of ['dev', 'stg', 'prd']) {
      expect(load(dir, `21gifts-debug-${env}`)?.namespace).toBe(`21gifts-debug-${env}`);
    }
  });

  it('keeps ed25519 lines and drops and logs every other line', () => {
    const dir = ring.signersDir({
      read: [
        '# operators',
        '',
        signerLine('alice', alice, `namespaces="${NS},21gifts-debug-stg"`),
        signerLine('ecdsa-user', ecdsa),
        signerLine('rsa-user', rsa, 'namespaces="21gifts-debug-dev"'),
      ],
      write: [
        signerLine('alice,bob', alice),
        signerLine('x', alice, 'cert-authority'),
        signerLine('y', alice, 'valid-before="20250231"'),
        'z ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==',
        'w ssh-ed25519 not*base64',
      ],
      admin: [signerLine('bob', bob, 'valid-before="20991231Z"')],
    });
    const signers = load(dir);
    expect(signers?.size).toBe(2);
    expect(signers?.allowedSignersText()).toBe(
      `${signerLine('alice', alice, `namespaces="${NS},21gifts-debug-stg"`)}\n${signerLine('bob', bob, 'valid-before="20991231Z"')}\n`,
    );
    const dropped = events().filter((e) => e['event'] === 'debug.auth.signers.line_dropped');
    expect(dropped.map((e) => [e['level'], e['line'], e['reason'], e['keyType']])).toEqual([
      ['read', 4, 'key_type', 'ecdsa-sha2-nistp256'],
      ['read', 5, 'key_type', 'ssh-rsa'],
      ['write', 1, 'principal', undefined],
      ['write', 2, 'option', undefined],
      ['write', 3, 'valid_before', undefined],
      ['write', 4, 'key', undefined],
      ['write', 5, 'key', undefined],
    ]);
    expect(events().at(-1)).toEqual(
      expect.objectContaining({
        event: 'debug.auth.signers.loaded',
        namespace: NS,
        read: 1,
        write: 0,
        admin: 1,
      }),
    );
  });

  it('drops short lines, unknown or empty options, and keys that are not one ed25519 key', () => {
    const blob = (typeLength: number, type: string, keyLength: number): string => {
      const typeBytes = Buffer.from(type);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(typeLength);
      const keyHead = Buffer.alloc(4);
      keyHead.writeUInt32BE(keyLength);
      return Buffer.concat([head, typeBytes, keyHead, Buffer.alloc(32)]).toString('base64');
    };
    const dir = ring.signersDir({
      read: [
        'alice',
        'alice ssh-ed25519',
        'alice namespaces="x"',
        `alice namespaces="x" ssh-ed25519`,
        signerLine('alice', alice, 'namespaces'),
        signerLine('alice', alice, 'Foo=bar'),
        signerLine('alice', alice, 'valid-before="soon"'),
        `alice ssh-ed25519 ${blob(12, 'ssh-ed25519', 32)}`,
        `alice ssh-ed25519 ${blob(11, 'ssh-ed25518', 32)}`,
        `alice ssh-ed25519 ${blob(11, 'ssh-ed25519', 31)}`,
        signerLine('alice', alice, `namespaces="${NS}",valid-before="20991231"`),
      ],
      write: [],
      admin: [],
    });
    const signers = load(dir);
    expect(signers?.size).toBe(1);
    expect(signers?.levelFor('alice', alice.fingerprint, Date.UTC(2099, 11, 30))).toBe('read');
    expect(signers?.levelFor('alice', alice.fingerprint, Date.UTC(2099, 11, 31))).toBeNull();
    const dropped = events().filter((e) => e['event'] === 'debug.auth.signers.line_dropped');
    expect(dropped.map((e) => e['reason'])).toEqual([
      'key_type',
      'key',
      'key_type',
      'key',
      'option',
      'option',
      'valid_before',
      'key',
      'key',
      'key',
    ]);
  });

  it('leaves out lines whose namespaces belong to another environment', () => {
    const dir = ring.signersDir({
      read: [signerLine('alice', alice)],
      write: [signerLine('alice', alice, 'namespaces="21gifts-debug-*,!21gifts-debug-dev"')],
      admin: [
        signerLine('alice', alice, 'namespaces="21gifts-debug-prd"'),
        signerLine('bob', bob, 'namespaces="21gifts-debug-d?v"'),
      ],
    });
    const signers = load(dir);
    expect(signers?.levelFor('alice', alice.fingerprint, 0)).toBe('read');
    expect(signers?.levelFor('bob', bob.fingerprint, 0)).toBe('admin');
    expect(signers?.allowedSignersText()).toBe(
      `${signerLine('alice', alice)}\n${signerLine('bob', bob, 'namespaces="21gifts-debug-d?v"')}\n`,
    );
    expect(events().at(-1)).toEqual(
      expect.objectContaining({
        event: 'debug.auth.signers.loaded',
        read: 1,
        write: 0,
        admin: 1,
        otherNamespace: 2,
      }),
    );
    expect(load(dir, '21gifts-debug-prd')?.levelFor('alice', alice.fingerprint, 0)).toBe('admin');
    expect(load(dir, '21gifts-debug-stg')?.levelFor('alice', alice.fingerprint, 0)).toBe('write');
  });

  it('reads the files through the injected reader with their fixed names', () => {
    const read: string[] = [];
    const signers = loadOperatorSigners(
      { DEBUG_ALLOWED_SIGNERS_DIR: '/signers', DEBUG_SIGNING_NAMESPACE: NS },
      (path) => {
        read.push(path);
        return '';
      },
    );
    expect(signers?.size).toBe(0);
    expect(read).toEqual(Object.values(OPERATOR_SIGNER_FILES).map((name) => `/signers/${name}`));
  });
});

describe('OperatorSigners', () => {
  it('gives a key listed in more than one file the highest level', () => {
    const dir = ring.signersDir({
      read: [signerLine('alice', alice)],
      write: [],
      admin: [signerLine('alice', alice)],
    });
    expect(load(dir)?.levelFor('alice', alice.fingerprint, Date.now())).toBe('admin');
  });

  it('matches the principal and the key together', () => {
    const dir = ring.signersDir({
      read: [signerLine('alice', alice), signerLine('bob', bob)],
      write: [],
      admin: [],
    });
    const signers = load(dir);
    expect(signers?.levelFor('alice', alice.fingerprint, 0)).toBe('read');
    expect(signers?.levelFor('alice', bob.fingerprint, 0)).toBeNull();
    expect(signers?.levelFor('carol', alice.fingerprint, 0)).toBeNull();
  });

  it('honours valid-before in every accepted form', () => {
    const cases: [string, number][] = [
      ['20300102', Date.UTC(2030, 0, 2)],
      ['203001021530', Date.UTC(2030, 0, 2, 15, 30)],
      ['20300102153045Z', Date.UTC(2030, 0, 2, 15, 30, 45)],
    ];
    for (const [value, end] of cases) {
      const dir = ring.signersDir({
        read: [],
        write: [signerLine('alice', alice, `valid-before="${value}"`)],
        admin: [signerLine('alice', alice, 'valid-before="20200101"')],
      });
      const signers = load(dir);
      expect(signers?.levelFor('alice', alice.fingerprint, end - 1)).toBe('write');
      expect(signers?.levelFor('alice', alice.fingerprint, end)).toBeNull();
    }
  });
});

describe('sshKeyFingerprint', () => {
  it('matches the fingerprint ssh-keygen prints', () => {
    const blob = Buffer.from(alice.publicKey.split(' ')[1] ?? '', 'base64');
    expect(sshKeyFingerprint(blob)).toBe(alice.fingerprint);
  });
});
