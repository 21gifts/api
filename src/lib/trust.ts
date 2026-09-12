/**
 * Trust-chain domain: stored edges, public graph, and per-account actors.
 *
 * `verified` is a founder or moderator confirming this person in real life
 * (forum badge), not Lightning-Address proof-of-control. Public
 * {@link buildTrustChain} never invents edges and never projects
 * `moderator_propose`.
 */

import type { Account, AccountRole } from '@/lib/auth/store';

/** Stored grant kind. `moderator_propose` is private to staff flows. */
export type TrustKind =
  | 'verify'
  | 'moderator_propose'
  | 'moderator_confirm'
  | 'moderator_appoint';

/** Edge kinds that appear on the public trust chain. */
export type TrustChainKind = 'verify' | 'moderator_confirm' | 'moderator_appoint';

/** One persisted who-granted-whom row. */
export interface TrustEdge {
  /** Opaque unique edge id (uuid). */
  id: string;
  /** Account receiving the status. */
  subjectId: string;
  /** Account granting the status. */
  actorId: string;
  /** Grant kind. */
  kind: TrustKind;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/** Public graph node (staff or verified; never `basis`). */
export interface TrustChainNode {
  /** Account id. */
  id: string;
  /** Display name, or `null` when unset. */
  name: string | null;
  /** Forum display role on the chain. */
  role: 'verified' | 'moderator' | 'founder';
}

/** Public graph edge (stored only; actor → subject). */
export interface TrustChainEdge {
  /** Actor account id. */
  from: string;
  /** Subject account id. */
  to: string;
  /** Public grant kind. */
  kind: TrustChainKind;
}

/** Public trust graph. */
export interface TrustChain {
  /** Chain nodes (founder, then moderator, then verified). */
  nodes: TrustChainNode[];
  /** Stored public edges whose endpoints are in `nodes`. */
  edges: TrustChainEdge[];
}

/** Live actor pointer on a member profile. */
export interface TrustActorRef {
  /** Actor account id. */
  id: string;
  /** Live display name, or `null` when the actor is missing or unnamed. */
  name: string | null;
}

/** Latest grant actors for one subject (all null when no edges). */
export interface AccountTrust {
  /** Latest `verify` actor. */
  verifiedBy: TrustActorRef | null;
  /** Latest `moderator_propose` actor. */
  proposedBy: TrustActorRef | null;
  /** Latest `moderator_confirm` actor. */
  confirmedBy: TrustActorRef | null;
  /** Latest `moderator_appoint` actor. */
  appointedBy: TrustActorRef | null;
}

/** JSON projection of a stored edge (`createdAt` as ISO-8601). */
export interface TrustEdgeJson {
  /** Opaque unique edge id. */
  id: string;
  /** Subject account id. */
  subjectId: string;
  /** Actor account id. */
  actorId: string;
  /** Grant kind. */
  kind: TrustKind;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

const ROLE_RANK: Record<TrustChainNode['role'], number> = {
  founder: 0,
  moderator: 1,
  verified: 2,
};

/**
 * Whether `role` may run staff trust POSTs (founder or moderator).
 *
 * @param role - Exclusive account role.
 * @returns `true` for `founder` and `moderator`.
 */
export function isStaffRole(role: AccountRole): boolean {
  return role === 'founder' || role === 'moderator';
}

/**
 * Project stored accounts and edges to the public trust graph.
 *
 * Nodes are accounts whose role is `founder`, `moderator`, or `verified`
 * (never `basis`), sorted founder → moderator → verified, then oldest
 * `createdAt`, then `id`. Edges are stored rows whose kind is `verify`,
 * `moderator_confirm`, or `moderator_appoint` and whose actor and subject
 * are both in the node set. `moderator_propose` is omitted. No synthetic
 * edges are added — a node with no stored incoming edge stays disconnected.
 * Lightning addresses, view keys, and linking keys are omitted.
 *
 * @param accounts - Live accounts (roles as stored).
 * @param edges - Stored trust edges (any order).
 * @returns Public `{ nodes, edges }`.
 */
export function buildTrustChain(
  accounts: readonly Account[],
  edges: readonly TrustEdge[],
): TrustChain {
  const chainAccounts = accounts
    .filter(isChainAccount)
    .slice()
    .sort(compareChainAccounts);
  const nodeIds = new Set(chainAccounts.map((account) => account.id));
  const nodes: TrustChainNode[] = chainAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    role: account.role,
  }));
  const publicEdges: TrustChainEdge[] = [];
  for (const edge of edges) {
    if (!isPublicEdgeKind(edge.kind)) {
      continue;
    }
    if (!nodeIds.has(edge.actorId) || !nodeIds.has(edge.subjectId)) {
      continue;
    }
    publicEdges.push({ from: edge.actorId, to: edge.subjectId, kind: edge.kind });
  }
  return { nodes, edges: publicEdges };
}

/**
 * Latest grant actors for `subjectId`.
 *
 * When several edges share a kind, the highest `createdAt` wins, then `id`.
 * Actor names come from the live account map; a missing actor is
 * `{ id, name: null }`.
 *
 * @param subjectId - Account whose grants to project.
 * @param accounts - Live accounts for actor name lookup.
 * @param edges - Stored edges (any subjects; filtered to `subjectId`).
 * @returns Four actor slots, each `null` when no edge of that kind exists.
 */
export function accountTrust(
  subjectId: string,
  accounts: readonly Account[],
  edges: readonly TrustEdge[],
): AccountTrust {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const mine = edges.filter((edge) => edge.subjectId === subjectId);
  return {
    verifiedBy: actorRef(latestOfKind(mine, 'verify'), byId),
    proposedBy: actorRef(latestOfKind(mine, 'moderator_propose'), byId),
    confirmedBy: actorRef(latestOfKind(mine, 'moderator_confirm'), byId),
    appointedBy: actorRef(latestOfKind(mine, 'moderator_appoint'), byId),
  };
}

/**
 * Project a stored edge to JSON (`createdAt` as ISO-8601).
 *
 * @param edge - Persisted edge.
 * @returns Public/debug edge fields; no extra account columns.
 */
export function serializeTrustEdge(edge: TrustEdge): TrustEdgeJson {
  return {
    id: edge.id,
    subjectId: edge.subjectId,
    actorId: edge.actorId,
    kind: edge.kind,
    createdAt: new Date(edge.createdAt).toISOString(),
  };
}

/** True when `account.role` appears on the public chain. */
function isChainAccount(
  account: Account,
): account is Account & { role: TrustChainNode['role'] } {
  return account.role === 'founder' || account.role === 'moderator' || account.role === 'verified';
}

/** True when `kind` is projected on the public chain. */
function isPublicEdgeKind(kind: TrustKind): kind is TrustChainKind {
  return kind === 'verify' || kind === 'moderator_confirm' || kind === 'moderator_appoint';
}

/** Founder, then moderator, then verified; oldest `createdAt`, then `id`. */
function compareChainAccounts(a: Account, b: Account): number {
  const aRole = a.role as TrustChainNode['role'];
  const bRole = b.role as TrustChainNode['role'];
  const byRole = ROLE_RANK[aRole] - ROLE_RANK[bRole];
  if (byRole !== 0) {
    return byRole;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/** Latest edge of `kind` (highest `createdAt`, then `id`). */
function latestOfKind(edges: readonly TrustEdge[], kind: TrustKind): TrustEdge | undefined {
  let best: TrustEdge | undefined;
  for (const edge of edges) {
    if (edge.kind !== kind) {
      continue;
    }
    if (
      best === undefined ||
      edge.createdAt > best.createdAt ||
      (edge.createdAt === best.createdAt && edge.id > best.id)
    ) {
      best = edge;
    }
  }
  return best;
}

/** Actor pointer from an edge, or `null` when no edge. */
function actorRef(
  edge: TrustEdge | undefined,
  byId: ReadonlyMap<string, Account>,
): TrustActorRef | null {
  if (edge === undefined) {
    return null;
  }
  const actor = byId.get(edge.actorId);
  return { id: edge.actorId, name: actor?.name ?? null };
}
