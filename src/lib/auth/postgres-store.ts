import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import type { SqlClient } from '@/lib/auth/sql';
import type {
  Account,
  AccountRole,
  AddressVerification,
  AuthStore,
  Challenge,
  ChallengeStatus,
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
  created_at: Date | string;
}

/** Row shape of `auth_challenge`. */
interface ChallengeRow {
  k1: string;
  poll_token: string;
  status: string;
  account_id: string | null;
  created_at: Date | string;
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

  async createChallenge(challenge: Challenge): Promise<void> {
    await this.#evictExpiredChallenges(challenge.createdAt);
    await this.#sql.execute(
      `INSERT INTO auth_challenge (k1, poll_token, status, account_id, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))`,
      [
        challenge.k1,
        challenge.pollToken,
        challenge.status,
        challenge.accountId,
        challenge.createdAt,
      ],
    );
  }

  async getChallenge(k1: string): Promise<Challenge | undefined> {
    const rows = await this.#sql.query<ChallengeRow>(
      'SELECT k1, poll_token, status, account_id, created_at FROM auth_challenge WHERE k1 = $1',
      [k1],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapChallenge(row);
  }

  async getChallengeByPollToken(pollToken: string): Promise<Challenge | undefined> {
    const rows = await this.#sql.query<ChallengeRow>(
      'SELECT k1, poll_token, status, account_id, created_at FROM auth_challenge WHERE poll_token = $1',
      [pollToken],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapChallenge(row);
  }

  async updateChallenge(challenge: Challenge): Promise<boolean> {
    const expected =
      challenge.status === 'authenticated'
        ? 'pending'
        : challenge.status === 'consumed'
          ? 'authenticated'
          : null;
    const rows = await this.#sql.query<{ k1: string }>(
      expected === null
        ? `UPDATE auth_challenge
           SET poll_token = $2, status = $3, account_id = $4, created_at = to_timestamp($5::double precision / 1000.0)
           WHERE k1 = $1
           RETURNING k1`
        : `UPDATE auth_challenge
           SET poll_token = $2, status = $3, account_id = $4, created_at = to_timestamp($5::double precision / 1000.0)
           WHERE k1 = $1 AND status = $6
           RETURNING k1`,
      expected === null
        ? [
            challenge.k1,
            challenge.pollToken,
            challenge.status,
            challenge.accountId,
            challenge.createdAt,
          ]
        : [
            challenge.k1,
            challenge.pollToken,
            challenge.status,
            challenge.accountId,
            challenge.createdAt,
            expected,
          ],
    );
    return rows[0] !== undefined;
  }

  async findAccountByLinkingKey(linkingKey: string): Promise<Account | undefined> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, created_at
       FROM account WHERE linking_key = $1`,
      [linkingKey],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async createAccount(account: Account): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO account (id, linking_key, role, name, lightning_address, lightning_address_verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0))
       ON CONFLICT (linking_key) DO NOTHING`,
      [
        account.id,
        account.linkingKey,
        account.role,
        account.name,
        account.lightningAddress,
        account.lightningAddressVerified,
        account.createdAt,
      ],
    );
  }

  async updateAccount(account: Account): Promise<void> {
    await this.#sql.execute(
      `UPDATE account
       SET linking_key = $2, role = $3, name = $4, lightning_address = $5, lightning_address_verified = $6,
           created_at = to_timestamp($7::double precision / 1000.0)
       WHERE id = $1`,
      [
        account.id,
        account.linkingKey,
        account.role,
        account.name,
        account.lightningAddress,
        account.lightningAddressVerified,
        account.createdAt,
      ],
    );
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, created_at
       FROM account WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.#sql.query<AccountRow>(
      `SELECT id, linking_key, role, name, lightning_address, lightning_address_verified, created_at
       FROM account ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(mapAccount);
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

  async createPasskeyCredential(credential: PasskeyCredential): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO passkey_credential (credential_id, public_key, sign_count, account_id, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))`,
      [
        credential.credentialId,
        credential.publicKey,
        credential.signCount,
        credential.accountId,
        credential.createdAt,
      ],
    );
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

  async updatePasskeyCredential(credential: PasskeyCredential): Promise<void> {
    await this.#sql.execute(
      `UPDATE passkey_credential
       SET public_key = $2, sign_count = $3, account_id = $4,
           created_at = to_timestamp($5::double precision / 1000.0)
       WHERE credential_id = $1`,
      [
        credential.credentialId,
        credential.publicKey,
        credential.signCount,
        credential.accountId,
        credential.createdAt,
      ],
    );
  }

  async #evictExpiredChallenges(now: number): Promise<void> {
    const cutoff = now - CHALLENGE_TTL_MS;
    await this.#sql.execute(
      'DELETE FROM auth_challenge WHERE created_at < to_timestamp($1::double precision / 1000.0)',
      [cutoff],
    );
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

function epochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function parseRole(raw: string): AccountRole {
  if (raw === 'basis' || raw === 'moderator') {
    return raw;
  }
  throw new Error(`Unknown account role "${raw}"`);
}

function parseChallengeStatus(raw: string): ChallengeStatus {
  if (raw === 'pending' || raw === 'authenticated' || raw === 'consumed') {
    return raw;
  }
  throw new Error(`Unknown challenge status "${raw}"`);
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    linkingKey: row.linking_key,
    role: parseRole(row.role),
    name: row.name,
    lightningAddress: row.lightning_address,
    lightningAddressVerified: row.lightning_address_verified,
    createdAt: epochMs(row.created_at),
  };
}

function mapChallenge(row: ChallengeRow): Challenge {
  return {
    k1: row.k1,
    pollToken: row.poll_token,
    status: parseChallengeStatus(row.status),
    accountId: row.account_id,
    createdAt: epochMs(row.created_at),
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
