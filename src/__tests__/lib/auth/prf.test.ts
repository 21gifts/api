import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PRF_EVAL_FIRST_LABEL, prfEvalFirstSalt } from '@/lib/auth/prf';

const FIXTURE_HEX = '7e5cd823b03bfcf258c15de44a83ed49978ebf5de69548ed3f931110912653e7';

describe('prfEvalFirstSalt', () => {
  it('is SHA-256 of the frozen label and 32 bytes', () => {
    expect(PRF_EVAL_FIRST_LABEL).toBe('21gifts-nostr-v1');
    const salt = prfEvalFirstSalt();
    expect(salt).toHaveLength(32);
    expect(Buffer.from(salt).toString('hex')).toBe(FIXTURE_HEX);
    expect(Buffer.from(salt).toString('hex')).toBe(
      createHash('sha256').update(PRF_EVAL_FIRST_LABEL, 'utf8').digest('hex'),
    );
    expect(Buffer.from(prfEvalFirstSalt()).toString('hex')).toBe(FIXTURE_HEX);
  });
});
