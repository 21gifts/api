import { describe, expect, it } from 'vitest';
import { capPasskeyRenewText, redactPasskeyRenewMessage } from '@/lib/auth/passkey-renew-report';

describe('redactPasskeyRenewMessage', () => {
  it('returns null for null and whitespace-only values', () => {
    expect(redactPasskeyRenewMessage(null)).toBeNull();
    expect(redactPasskeyRenewMessage('')).toBeNull();
    expect(redactPasskeyRenewMessage('   \n\t  ')).toBeNull();
  });

  it('redacts a 12-word phrase under 500 characters before capping', () => {
    const phrase = 'one two three four five six seven eight nine ten eleven twelve';
    expect(phrase.length).toBeLessThan(500);
    expect(redactPasskeyRenewMessage(phrase)).toBe('[redacted]');
  });

  it('redacts an 81-character run that starts after character 500', () => {
    const head = `${'x'.repeat(80)}.`.repeat(6) + 'y'.repeat(14);
    expect(head.length).toBe(500);
    const value = `${head}.${'z'.repeat(81)}`;
    expect(value.slice(0, 500)).toBe(head);
    expect(redactPasskeyRenewMessage(value)).toBe('[redacted]');
  });

  it('caps a normal message longer than 500 that is not itself a dump', () => {
    const token = 'a'.repeat(50);
    const value = Array.from({ length: 11 }, () => token).join(' ');
    expect(value.split(/\s+/)).toHaveLength(11);
    expect(value.length).toBeGreaterThan(500);
    expect(redactPasskeyRenewMessage(value)).toBe(value.slice(0, 500));
  });

  it('redacts a 64-character hex token', () => {
    expect(redactPasskeyRenewMessage('a'.repeat(64))).toBe('[redacted]');
  });

  it('returns a short normal message trimmed and unchanged', () => {
    expect(redactPasskeyRenewMessage('seed failed')).toBe('seed failed');
    expect(redactPasskeyRenewMessage('  seed failed  ')).toBe('seed failed');
  });
});

describe('capPasskeyRenewText', () => {
  it('returns null for null and blank values', () => {
    expect(capPasskeyRenewText(null, 80)).toBeNull();
    expect(capPasskeyRenewText('', 80)).toBeNull();
    expect(capPasskeyRenewText('   \n\t  ', 80)).toBeNull();
  });

  it('trims and slices over the max', () => {
    expect(capPasskeyRenewText('  hello  ', 80)).toBe('hello');
    expect(capPasskeyRenewText('abcdef', 3)).toBe('abc');
    expect(capPasskeyRenewText('abcd', 4)).toBe('abcd');
  });
});
