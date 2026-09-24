import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryTranslationStore,
  PostgresTranslationStore,
  TRANSLATION_SCHEMA_SQL,
  translationSourceHash,
} from '@/lib/translation-store';

describe('translationSourceHash', () => {
  it('is stable for the same UTF-8 text', () => {
    expect(translationSourceHash('Hallo')).toBe(translationSourceHash('Hallo'));
    expect(translationSourceHash('Hallo')).not.toBe(translationSourceHash('Hallo!'));
  });
});

describe('InMemoryTranslationStore', () => {
  it('returns null for a miss and keeps the first writer for a hash', async () => {
    const store = new InMemoryTranslationStore();
    expect(await store.get('id', 'en')).toBeNull();
    expect(await store.put('id', 'en', 'hash-a', 'Hello')).toBe('Hello');
    expect(await store.put('id', 'en', 'hash-a', 'Hello again')).toBe('Hello');
    expect(await store.put('id', 'en', 'hash-b', 'Hi')).toBe('Hi');
    expect(await store.get('id', 'en')).toEqual({
      sourceSha256: 'hash-b',
      translatedText: 'Hi',
    });
  });
});

describe('TRANSLATION_SCHEMA_SQL', () => {
  it('creates message_translation with a composite primary key', () => {
    expect(TRANSLATION_SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS message_translation/);
    expect(TRANSLATION_SCHEMA_SQL).toMatch(/PRIMARY KEY \(message_id, target_lang\)/);
    expect(TRANSLATION_SCHEMA_SQL).toMatch(/ON DELETE CASCADE/);
  });
});

describe('PostgresTranslationStore', () => {
  it('selects and upserts with first-writer-wins on the same hash', async () => {
    const sql: SqlClient = {
      async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        if (text.includes('SELECT source_sha256')) {
          expect(params).toEqual(['mid', 'en']);
          return [{ source_sha256: 'h', translated_text: 'Hello' }] as T[];
        }
        expect(text).toMatch(/ON CONFLICT \(message_id, target_lang\) DO UPDATE/);
        expect(params[3]).toBe('Hello 2');
        return [{ translated_text: 'Hello' }] as T[];
      },
      async execute(): Promise<void> {
        throw new Error('execute unused');
      },
    };
    const store = new PostgresTranslationStore(sql);
    expect(await store.get('mid', 'en')).toEqual({
      sourceSha256: 'h',
      translatedText: 'Hello',
    });
    expect(await store.put('mid', 'en', 'h', 'Hello 2')).toBe('Hello');
  });

  it('returns null on an empty select and throws when upsert returns no row', async () => {
    const empty: SqlClient = {
      async query<T>(): Promise<T[]> {
        return [];
      },
      async execute(): Promise<void> {
        throw new Error('execute unused');
      },
    };
    const store = new PostgresTranslationStore(empty);
    expect(await store.get('mid', 'en')).toBeNull();
    await expect(store.put('mid', 'en', 'h', 'Hello')).rejects.toThrow(
      'message_translation upsert returned no row',
    );
  });

  it('selects and upserts conversation_message_translation when that table is set', async () => {
    const sql: SqlClient = {
      async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        if (text.includes('SELECT source_sha256')) {
          expect(text).toMatch(/FROM conversation_message_translation/);
          expect(params).toEqual(['mid', 'en']);
          return [{ source_sha256: 'h', translated_text: 'Hello' }] as T[];
        }
        expect(text).toMatch(/INSERT INTO conversation_message_translation/);
        expect(text).toMatch(/ON CONFLICT \(message_id, target_lang\) DO UPDATE/);
        expect(params[3]).toBe('Hello 2');
        return [{ translated_text: 'Hello' }] as T[];
      },
      async execute(): Promise<void> {
        throw new Error('execute unused');
      },
    };
    const store = new PostgresTranslationStore(sql, 'conversation_message_translation');
    expect(await store.get('mid', 'en')).toEqual({
      sourceSha256: 'h',
      translatedText: 'Hello',
    });
    expect(await store.put('mid', 'en', 'h', 'Hello 2')).toBe('Hello');
  });

  it('throws when conversation_message_translation upsert returns no row', async () => {
    const empty: SqlClient = {
      async query<T>(): Promise<T[]> {
        return [];
      },
      async execute(): Promise<void> {
        throw new Error('execute unused');
      },
    };
    const store = new PostgresTranslationStore(empty, 'conversation_message_translation');
    expect(await store.get('mid', 'en')).toBeNull();
    await expect(store.put('mid', 'en', 'h', 'Hello')).rejects.toThrow(
      'conversation_message_translation upsert returned no row',
    );
  });
});
