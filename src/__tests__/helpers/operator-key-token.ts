import { createHash } from 'node:crypto';
import type { OperatorLevel } from '@/lib/operator';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';
import { OperatorSigners } from '@/lib/operator-signers';

/** Fingerprint of the made-up key the seeded tokens belong to. */
export const SEEDED_FINGERPRINT = 'SHA256:seeded-test-key';

/**
 * A loaded key login with one listed operator per level and a stored token
 * for each, seeded straight into the store (no `ssh-keygen` run).
 *
 * @param now - Clock of the login.
 * @returns The login, its signers and store (for `createApp`), and the bearer token of each level.
 */
export async function seededOperatorLogin(now: () => number = Date.now): Promise<{
  operatorLogin: OperatorLogin;
  operatorSigners: OperatorSigners;
  operatorLoginStore: InMemoryOperatorLoginStore;
  tokens: Record<OperatorLevel, string>;
}> {
  const levels: OperatorLevel[] = ['read', 'write', 'admin'];
  const signers = new OperatorSigners(
    '21gifts-debug-dev',
    levels.map((level) => ({
      principal: `op-${level}`,
      level,
      fingerprint: SEEDED_FINGERPRINT,
      validBefore: null,
      line: `op-${level} ssh-ed25519 AAAA`,
    })),
  );
  const store = new InMemoryOperatorLoginStore();
  const tokens = {} as Record<OperatorLevel, string>;
  for (const level of levels) {
    const token = `op_${level.padEnd(43, 'x')}`;
    tokens[level] = token;
    await store.addToken({
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      operator: `op-${level}`,
      keyFingerprint: SEEDED_FINGERPRINT,
      level,
      createdAt: now(),
      expiresAt: now() + 15 * 60_000,
    });
  }
  return {
    operatorLogin: new OperatorLogin({ signers, store, now }),
    operatorSigners: signers,
    operatorLoginStore: store,
    tokens,
  };
}
