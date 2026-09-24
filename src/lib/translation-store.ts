import { createHash } from 'node:crypto';
import type { SqlClient } from '@/lib/auth/sql';
import type { TranslateTarget } from '@/lib/translate-config';

/** Cached DeepL result for one message and UI locale. */
export interface MessageTranslation {
  /** SHA-256 hex of the source `message.text` that was translated. */
  sourceSha256: string;
  /** Translated body. */
  translatedText: string;
}

/** Persistence for per-message, per-locale DeepL results. */
export interface TranslationStore {
  /**
   * Load a cached translation.
   *
   * @param messageId - Forum message UUID.
   * @param targetLang - UI locale.
   * @returns The row, or `null` when missing.
   */
  get(messageId: string, targetLang: TranslateTarget): Promise<MessageTranslation | null>;
  /**
   * Insert or replace a translation. When a row already exists for the same
   * source hash, keep the stored text (first writer wins).
   *
   * @param messageId - Forum message UUID.
   * @param targetLang - UI locale.
   * @param sourceSha256 - Hash of the source text sent to DeepL.
   * @param translatedText - DeepL output.
   * @returns The text that is now stored.
   */
  put(
    messageId: string,
    targetLang: TranslateTarget,
    sourceSha256: string,
    translatedText: string,
  ): Promise<string>;
}

/**
 * SHA-256 of UTF-8 `message.text`.
 *
 * @param text - Stored forum body.
 * @returns Lowercase hex digest.
 */
export function translationSourceHash(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function rowKey(messageId: string, targetLang: TranslateTarget): string {
  return `${messageId}\0${targetLang}`;
}

/** In-process translation cache (tests and memory boots). */
export class InMemoryTranslationStore implements TranslationStore {
  private readonly rows = new Map<string, MessageTranslation>();

  /** {@inheritdoc} */
  async get(messageId: string, targetLang: TranslateTarget): Promise<MessageTranslation | null> {
    return this.rows.get(rowKey(messageId, targetLang)) ?? null;
  }

  /** {@inheritdoc} */
  async put(
    messageId: string,
    targetLang: TranslateTarget,
    sourceSha256: string,
    translatedText: string,
  ): Promise<string> {
    const key = rowKey(messageId, targetLang);
    const existing = this.rows.get(key);
    if (existing !== undefined && existing.sourceSha256 === sourceSha256) {
      return existing.translatedText;
    }
    this.rows.set(key, { sourceSha256, translatedText });
    return translatedText;
  }
}

/** Idempotent DDL. Applied with {@link MESSAGE_SCHEMA_SQL}. */
export const TRANSLATION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS message_translation (
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  target_lang text NOT NULL,
  source_sha256 text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, target_lang)
)`;

/** Postgres-backed translation cache. */
export class PostgresTranslationStore implements TranslationStore {
  /**
   * @param sql - Parameter-bound SQL client.
   */
  constructor(private readonly sql: SqlClient) {}

  /** {@inheritdoc} */
  async get(messageId: string, targetLang: TranslateTarget): Promise<MessageTranslation | null> {
    const rows = await this.sql.query<{ source_sha256: string; translated_text: string }>(
      `SELECT source_sha256, translated_text
         FROM message_translation
        WHERE message_id = $1::uuid AND target_lang = $2`,
      [messageId, targetLang],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return { sourceSha256: row.source_sha256, translatedText: row.translated_text };
  }

  /** {@inheritdoc} */
  async put(
    messageId: string,
    targetLang: TranslateTarget,
    sourceSha256: string,
    translatedText: string,
  ): Promise<string> {
    const rows = await this.sql.query<{ translated_text: string }>(
      `INSERT INTO message_translation (
         message_id, target_lang, source_sha256, translated_text, created_at
       ) VALUES ($1::uuid, $2, $3, $4, NOW())
       ON CONFLICT (message_id, target_lang) DO UPDATE
         SET source_sha256 = EXCLUDED.source_sha256,
             translated_text = CASE
               WHEN message_translation.source_sha256 = EXCLUDED.source_sha256
               THEN message_translation.translated_text
               ELSE EXCLUDED.translated_text
             END,
             created_at = CASE
               WHEN message_translation.source_sha256 = EXCLUDED.source_sha256
               THEN message_translation.created_at
               ELSE NOW()
             END
       RETURNING translated_text`,
      [messageId, targetLang, sourceSha256, translatedText],
    );
    const stored = rows[0]?.translated_text;
    if (stored === undefined) {
      throw new Error('message_translation upsert returned no row');
    }
    return stored;
  }
}
