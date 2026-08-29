/**
 * Private in-app contact domain: public and debug JSON projection.
 *
 * Text validation reuses {@link normalizeForumText} from the forum message
 * module — same trim, length, and control-character rules. Contacts are
 * never listed on a member-facing route; operators read them via
 * `/debug/contacts`.
 */

/** Persisted contact row (store-internal; includes `accountId`). */
export interface ContactRow {
  /** Opaque unique contact id. */
  id: string;
  /** Author account id. */
  accountId: string;
  /** Display name snapshotted at post time. */
  name: string;
  /** Contact body (already normalised). */
  text: string;
  /** Creation instant. */
  createdAt: Date;
}

/** Public JSON shape of a contact (no `accountId`). */
export interface PublicContact {
  /** Opaque unique contact id. */
  id: string;
  /** Author display name at post time. */
  name: string;
  /** Contact body. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Operator JSON shape of a contact (includes `accountId`). */
export interface DebugContact {
  /** Opaque unique contact id. */
  id: string;
  /** Author account id. */
  accountId: string;
  /** Author display name at post time. */
  name: string;
  /** Contact body. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted contact.
 * @returns Public fields only (`accountId` omitted); `createdAt` as ISO-8601.
 */
export function serializeContact(row: ContactRow): PublicContact {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Project a store row to its operator debug JSON shape.
 *
 * @param row - Persisted contact.
 * @returns Debug fields including `accountId`; `createdAt` as ISO-8601.
 */
export function serializeDebugContact(row: ContactRow): DebugContact {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}
