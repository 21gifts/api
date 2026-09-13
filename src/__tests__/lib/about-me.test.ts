import { describe, expect, it } from 'vitest';
import { aboutMeFromNote } from '@/lib/about-me';

describe('aboutMeFromNote', () => {
  it('returns null for null or blank text', () => {
    expect(aboutMeFromNote('Ada', null)).toBeNull();
    expect(aboutMeFromNote('Ada', '')).toBeNull();
    expect(aboutMeFromNote('Ada', '   ')).toBeNull();
  });

  it('returns null when trimmed text equals the trimmed display name, case-insensitively', () => {
    expect(aboutMeFromNote('Ada', 'Ada')).toBeNull();
    expect(aboutMeFromNote('Ada', 'ada')).toBeNull();
    expect(aboutMeFromNote('  Ada  ', 'ADA')).toBeNull();
  });

  it('returns the trimmed bio when it is not the display name', () => {
    expect(aboutMeFromNote('Ada', '  I build on Bitcoin  ')).toBe('I build on Bitcoin');
    expect(aboutMeFromNote('Ada', 'Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('returns the trimmed text when the display name is null or blank', () => {
    expect(aboutMeFromNote(null, 'Hello')).toBe('Hello');
    expect(aboutMeFromNote('   ', 'Hello')).toBe('Hello');
    expect(aboutMeFromNote(null, '   ')).toBeNull();
  });
});
