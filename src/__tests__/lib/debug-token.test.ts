import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDistinctDebugTokens,
  bearerMatchesDebugToken,
  classifyDebugDbBearer,
} from '@/lib/debug-token';
import { setDiagnosticSink } from '@/lib/log';
import { createApp } from '@/server';

const TOKEN = 'op-secret-token';
const WRITE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const READ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('bearerMatchesDebugToken', () => {
  it('accepts an exact Bearer match', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(bearerMatchesDebugToken(TOKEN, undefined)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Basic ${TOKEN}`)).toBe(false);
  });

  it('rejects a different token of the same length', () => {
    expect(bearerMatchesDebugToken(TOKEN, 'Bearer op-secret-tokem')).toBe(false);
  });

  it('rejects a different length token', () => {
    expect(bearerMatchesDebugToken(TOKEN, 'Bearer short')).toBe(false);
  });

  it('trims the presented token', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Bearer ${TOKEN}  `)).toBe(true);
  });

  it('trims the configured token', () => {
    expect(bearerMatchesDebugToken(`  ${TOKEN}  `, `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('assertDistinctDebugTokens', () => {
  it('throws when both tokens are equal after trim', () => {
    expect(() => assertDistinctDebugTokens(WRITE, WRITE)).toThrow(
      'DEBUG_READ_TOKEN matches DEBUG_TOKEN',
    );
    expect(() => assertDistinctDebugTokens(`  ${WRITE}  `, WRITE)).toThrow(
      'DEBUG_READ_TOKEN matches DEBUG_TOKEN',
    );
  });

  it('does not throw when one token is empty', () => {
    expect(() => assertDistinctDebugTokens(undefined, undefined)).not.toThrow();
    expect(() => assertDistinctDebugTokens(undefined, READ)).not.toThrow();
    expect(() => assertDistinctDebugTokens(WRITE, undefined)).not.toThrow();
    expect(() => assertDistinctDebugTokens('', READ)).not.toThrow();
    expect(() => assertDistinctDebugTokens(WRITE, '   ')).not.toThrow();
  });

  it('does not throw when the tokens differ', () => {
    expect(() => assertDistinctDebugTokens(WRITE, READ)).not.toThrow();
    expect(() => assertDistinctDebugTokens('short', WRITE)).not.toThrow();
  });
});

describe('classifyDebugDbBearer', () => {
  it('returns unconfigured when both tokens are empty', () => {
    expect(classifyDebugDbBearer(undefined, undefined, `Bearer ${WRITE}`)).toBe('unconfigured');
    expect(classifyDebugDbBearer('  ', '  ', `Bearer ${WRITE}`)).toBe('unconfigured');
  });

  it('returns write when the bearer matches the write token', () => {
    expect(classifyDebugDbBearer(WRITE, READ, `Bearer ${WRITE}`)).toBe('write');
    expect(classifyDebugDbBearer(WRITE, undefined, `Bearer ${WRITE}`)).toBe('write');
  });

  it('returns read when the bearer matches the read token', () => {
    expect(classifyDebugDbBearer(WRITE, READ, `Bearer ${READ}`)).toBe('read');
    expect(classifyDebugDbBearer(undefined, READ, `Bearer ${READ}`)).toBe('read');
  });

  it('returns unauthorized when the bearer matches neither configured token', () => {
    expect(classifyDebugDbBearer(WRITE, READ, 'Bearer other')).toBe('unauthorized');
    expect(classifyDebugDbBearer(WRITE, undefined, 'Bearer other')).toBe('unauthorized');
    expect(classifyDebugDbBearer(undefined, READ, 'Bearer other')).toBe('unauthorized');
    expect(classifyDebugDbBearer(WRITE, READ, undefined)).toBe('unauthorized');
  });
});

describe('createApp debug read token', () => {
  afterEach(() => {
    setDiagnosticSink(null);
  });

  it('throws when debugReadToken matches debugToken and does not echo the values', () => {
    let message = '';
    try {
      createApp({ debugToken: WRITE, debugReadToken: WRITE });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('DEBUG_READ_TOKEN matches DEBUG_TOKEN');
    expect(message).not.toContain(WRITE);
  });

  it('boots when debugToken and debugReadToken differ', () => {
    expect(() => createApp({ debugToken: WRITE, debugReadToken: READ })).not.toThrow();
  });
});
