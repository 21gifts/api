import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import type { SqlClient } from '@/lib/auth/sql';
import type {
  Account,
  AccountRole,
  AddressVerification,
  AuthStore,
  NostrKeyRecord,
  PasskeyChallenge,
  PasskeyChallengeType,
  PasskeyCredential,
  Session,
} from '@/lib/auth/store';

/** Row shape of `account`. */
interface AccountRow {
  id: string;
  linking_key: string | null;
  role: string;
  name: string | null;
  lightning_address: string | null;
  lightning_address_verified: boolean;
  forum_laws_dismissed: boolean;
  view_key: string | null;
  created_at: Date | string;
  rules_agreed_at: Date | string | null;
}

/** Row shape of `auth_session`. */
interface SessionRow {
  token: string;
  account_id: string;
  created_at: Date | string;
}

/** Row shape of `address_verification`. */
interface VerificationRow {
  account_id: string;
  address: string;
  nonce: string;
  created_at: Date | string;
}

/** Row shape of `passkey_challenge`. */
interface PasskeyChallengeRow {
  id: string;
  type: string;
  challenge: string;
  account_id: string | null;
  consumed: boolean;
  created_at: Date | string;
}

/** Row shape of `passkey_credential`. */
interface PasskeyCredentialRow {
  credential_id: string;
  public_key: Uint8Array;
  sign_count: number;
  account_id: string;
  created_at: Date | string;
}

/**
 * Apply {@link AUTH_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateAuthSchema(sql: SqlClient): Promise<void> {
  for (const statement of AUTH_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Durable {@link AuthStore} backed by Postgres. Same eviction-on-write
 * semantics as {@link InMemoryAuthStore}.
 */
export class PostgresAuthStore implements AuthStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async createAccount(account: Account): Promise<void> {
    try {
      await this.#sql.execute(
        `INSERT INTO account (id, linking_key, role, name, lightning_address, lightning_address_verified, forum_laws_dismissed, created_at, view_key, rules_agreed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::double precision / 1000.0), $9, to_timestamp($10::double precision / 1000.0))
         ON CONFLICT (linking_key) DO NOTHING`,
        [
          account.id,
          account.linkingKey,
          account.role,
          account.name,
          account.lightningAddress,
          account.lightningAddressVerified,
          account.forumLawsDismissed,
          account.createdAt,
          account.viewKey,
          account.rulesAgreedAt,
        ],
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  }

  async updateAccount(account: Account): Promise<void> {
    try {
      await this.#sql.execute(
        `UPDATE account
         SET linking_key = $2, role = $3, name = $4, lightning_address = $5, lightning_address_verified = $6,
             forum_laws_dismissed = $7,
             created_at = to_timestamp($8::double precision / 1000.0), view_key = $9,
             rules_agreed_at = to_timestamp($10::double precision / 1000.0)
         WHERE id = $1
           AND (
             $2::text IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM account other
               WHERE other.linking_key = $2 AND other.id <> $1
             )
           )`,
        [
          account.id,
          account.linkingKey,
          account.role,
          account.name,
          account.lightningAddress,
          account.lightningAddressVerified,
          account.forumLawsDismissed,
          account.createdAt,
          account.viewKey,
          account.rulesAgreedAt,
        ],
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, forum_laws_dismissed, view_key, created_at, rules_agreed_at
       FROM account WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async getAccountByViewKey(viewKey: string): Promise<Account | undefined> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, forum_laws_dismissed, view_key, created_at, rules_agreed_at
       FROM account WHERE view_key = $1`,
      [viewKey],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async getAccountByLightningAddress(address: string): Promise<Account | undefined> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, forum_laws_dismissed, view_key, created_at, rules_agreed_at
       FROM account WHERE lower(trim(lightning_address)) = lower(trim($1))`,
      [address],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async accountHasPasskey(accountId: string): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      'SELECT 1 FROM passkey_credential WHERE account_id = $1 LIMIT 1',
      [accountId],
    );
    return rows[0] !== undefined;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.#sql.execute('DELETE FROM account WHERE id = $1', [id]);
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, forum_laws_dismissed, view_key, created_at, rules_agreed_at
       FROM account ORDER BY created_at ASC, id ASC`,
    );
    const accounts: Account[] = [];
    for (const row of rows) {
      const mapped = mapAccount(row);
      if (mapped !== undefined) {
        accounts.push(mapped);
      }
    }
    return accounts;
  }

  async createSession(session: Session): Promise<void> {
    await this.#evictExpiredSessions(session.createdAt);
    await this.#sql.execute(
      `INSERT INTO auth_session (token, account_id, created_at)
       VALUES ($1, $2, to_timestamp($3::double precision / 1000.0))`,
      [session.token, session.accountId, session.createdAt],
    );
  }

  async getSession(token: string): Promise<Session | undefined> {
    const rows = await this.#sql.query<SessionRow>(
      'SELECT token, account_id, created_at FROM auth_session WHERE token = $1',
      [token],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapSession(row);
  }

  async putVerification(verification: AddressVerification): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO address_verification (account_id, address, nonce, created_at)
       VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0))
       ON CONFLICT (account_id) DO UPDATE SET
         address = EXCLUDED.address,
         nonce = EXCLUDED.nonce,
         created_at = EXCLUDED.created_at`,
      [verification.accountId, verification.address, verification.nonce, verification.createdAt],
    );
  }

  async getVerification(accountId: string): Promise<AddressVerification | undefined> {
    const rows = await this.#sql.query<VerificationRow>(
      'SELECT account_id, address, nonce, created_at FROM address_verification WHERE account_id = $1',
      [accountId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapVerification(row);
  }

  async deleteVerification(accountId: string): Promise<void> {
    await this.#sql.execute('DELETE FROM address_verification WHERE account_id = $1', [accountId]);
  }

  async createPasskeyChallenge(challenge: PasskeyChallenge): Promise<void> {
    await this.#evictExpiredPasskeyChallenges(challenge.createdAt);
    await this.#sql.execute(
      `INSERT INTO passkey_challenge (id, type, challenge, account_id, consumed, created_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000.0))`,
      [
        challenge.id,
        challenge.type,
        challenge.challenge,
        challenge.accountId,
        challenge.consumed,
        challenge.createdAt,
      ],
    );
  }

  async getPasskeyChallenge(id: string): Promise<PasskeyChallenge | undefined> {
    const rows = await this.#sql.query<PasskeyChallengeRow>(
      `SELECT id, type, challenge, account_id, consumed, created_at
       FROM passkey_challenge WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapPasskeyChallenge(row);
  }

  async updatePasskeyChallenge(challenge: PasskeyChallenge): Promise<boolean> {
    const rows = await this.#sql.query<{ id: string }>(
      `UPDATE passkey_challenge
       SET type = $2, challenge = $3, account_id = $4, consumed = $5,
           created_at = to_timestamp($6::double precision / 1000.0)
       WHERE id = $1 AND consumed = false
       RETURNING id`,
      [
        challenge.id,
        challenge.type,
        challenge.challenge,
        challenge.accountId,
        challenge.consumed,
        challenge.createdAt,
      ],
    );
    return rows[0] !== undefined;
  }

  async createPasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    const rows = await this.#sql.query<{ credential_id: string }>(
      `INSERT INTO passkey_credential (credential_id, public_key, sign_count, account_id, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))
       ON CONFLICT (credential_id) DO NOTHING
       RETURNING credential_id`,
      [
        credential.credentialId,
        credential.publicKey,
        credential.signCount,
        credential.accountId,
        credential.createdAt,
      ],
    );
    return rows[0] !== undefined;
  }

  async createFirstPasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    try {
      const rows = await this.#sql.query<{ credential_id: string }>(
        `INSERT INTO passkey_credential (credential_id, public_key, sign_count, account_id, created_at)
         SELECT $1, $2, $3, $4, to_timestamp($5::double precision / 1000.0)
         WHERE NOT EXISTS (
           SELECT 1 FROM passkey_credential WHERE account_id = $4
         )
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING credential_id`,
        [
          credential.credentialId,
          credential.publicKey,
          credential.signCount,
          credential.accountId,
          credential.createdAt,
        ],
      );
      return rows[0] !== undefined;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async getPasskeyCredential(credentialId: string): Promise<PasskeyCredential | undefined> {
    const rows = await this.#sql.query<PasskeyCredentialRow>(
      `SELECT credential_id, public_key, sign_count, account_id, created_at
       FROM passkey_credential WHERE credential_id = $1`,
      [credentialId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapPasskeyCredential(row);
  }

  async updatePasskeyCredential(credential: PasskeyCredential): Promise<boolean> {
    const rows = await this.#sql.query<{ credential_id: string }>(
      `UPDATE passkey_credential
       SET sign_count = $2
       WHERE credential_id = $1
         AND (
           ($2 = 0 AND sign_count = 0)
           OR $2 > sign_count
         )
       RETURNING credential_id`,
      [credential.credentialId, credential.signCount],
    );
    return rows[0] !== undefined;
  }

  async getNostrPublicKey(accountId: string): Promise<string | undefined> {
    const rows = await this.#sql.query<{ nostr_pubkey: string | null }>(
      'SELECT nostr_pubkey FROM account WHERE id = $1',
      [accountId],
    );
    const pubkey = rows[0]?.nostr_pubkey;
    return pubkey === null || pubkey === undefined ? undefined : pubkey;
  }

  async getNostrSecret(accountId: string): Promise<Uint8Array | undefined> {
    const rows = await this.#sql.query<{ nostr_nsec_ciphertext: Uint8Array | null }>(
      'SELECT nostr_nsec_ciphertext FROM account WHERE id = $1',
      [accountId],
    );
    const blob = rows[0]?.nostr_nsec_ciphertext;
    return blob === null || blob === undefined ? undefined : new Uint8Array(blob);
  }

  async setNostrKeyIfAbsent(
    accountId: string,
    record: NostrKeyRecord,
  ): Promise<'inserted' | 'exists'> {
    const rows = await this.#sql.query<{ nostr_pubkey: string }>(
      `UPDATE account
       SET nostr_pubkey = $2,
           nostr_nsec_ciphertext = $3,
           nostr_kek_id = $4,
           nostr_key_custody = $5,
           nostr_key_created_at = now()
       WHERE id = $1 AND nostr_pubkey IS NULL
       RETURNING nostr_pubkey`,
      [accountId, record.pubkey, record.ciphertext, record.kekId, record.custody],
    );
    return rows[0] === undefined ? 'exists' : 'inserted';
  }

  async listAccountIdsWithoutNostrKey(limit: number): Promise<string[]> {
    const rows = await this.#sql.query<{ id: string }>(
      `SELECT id FROM account WHERE nostr_pubkey IS NULL
       ORDER BY created_at ASC, id ASC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.id);
  }

  async #evictExpiredSessions(now: number): Promise<void> {
    const cutoff = now - SESSION_TTL_MS;
    await this.#sql.execute(
      'DELETE FROM auth_session WHERE created_at < to_timestamp($1::double precision / 1000.0)',
      [cutoff],
    );
  }

  async #evictExpiredPasskeyChallenges(now: number): Promise<void> {
    const cutoff = now - CHALLENGE_TTL_MS;
    await this.#sql.execute(
      'DELETE FROM passkey_challenge WHERE created_at < to_timestamp($1::double precision / 1000.0)',
      [cutoff],
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

function epochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function parseRole(raw: string): AccountRole {
  if (raw === 'basis' || raw === 'verified' || raw === 'moderator' || raw === 'founder') {
    return raw;
  }
  throw new Error(`Unknown account role "${raw}"`);
}

/**
 * Map a DB row to {@link Account}. Rows with a null `view_key` are skipped
 * (pre-backfill or incomplete migration) rather than inventing a key on read.
 */
function mapAccount(row: AccountRow): Account | undefined {
  if (row.view_key === null) {
    return undefined;
  }
  return {
    id: row.id,
    linkingKey: row.linking_key,
    role: parseRole(row.role),
    name: row.name,
    lightningAddress: row.lightning_address,
    lightningAddressVerified: row.lightning_address_verified,
    forumLawsDismissed: row.forum_laws_dismissed,
    viewKey: row.view_key,
    createdAt: epochMs(row.created_at),
    rulesAgreedAt: row.rules_agreed_at === null ? null : epochMs(row.rules_agreed_at),
  };
}

function mapSession(row: SessionRow): Session {
  return {
    token: row.token,
    accountId: row.account_id,
    createdAt: epochMs(row.created_at),
  };
}

function mapVerification(row: VerificationRow): AddressVerification {
  return {
    accountId: row.account_id,
    address: row.address,
    nonce: row.nonce,
    createdAt: epochMs(row.created_at),
  };
}

function parsePasskeyChallengeType(raw: string): PasskeyChallengeType {
  if (raw === 'register' || raw === 'authenticate') {
    return raw;
  }
  throw new Error(`Unknown passkey challenge type "${raw}"`);
}

function mapPasskeyChallenge(row: PasskeyChallengeRow): PasskeyChallenge {
  return {
    id: row.id,
    type: parsePasskeyChallengeType(row.type),
    challenge: row.challenge,
    accountId: row.account_id,
    consumed: row.consumed,
    createdAt: epochMs(row.created_at),
  };
}

function mapPasskeyCredential(row: PasskeyCredentialRow): PasskeyCredential {
  return {
    credentialId: row.credential_id,
    publicKey: row.public_key,
    signCount: row.sign_count,
    accountId: row.account_id,
    createdAt: epochMs(row.created_at),
  };
}
