/**
 * Trust-chain domain: stored edges, public graph, and per-account actors.
 *
 * `verified` is a moderator confirming this person in real life
 * (forum badge), not Lightning-Address proof-of-control. Public
 * {@link buildTrustChain} never invents edges. At most one public incoming
 * kind per subject: the oldest eligible sibling (`createdAt` then `id`).
 * Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when
 * the live subject is a `moderator`. `moderator_confirm` never. A pending
 * propose (subject still `verified`) stays private. Later appoint, confirm,
 * or propose do not replace an earlier eligible contact.
 */

import { roleAtLeast } from '@/lib/auth/roles';
import type { Account, AccountRole } from '@/lib/auth/store';

/** Stored grant kind. Pending `moderator_propose` is staff-only until the subject is a moderator. */
export type TrustKind = 'verify' | 'moderator_propose' | 'moderator_confirm' | 'moderator_appoint';

/** Edge kinds that appear on the public trust chain. */
export type TrustChainKind = 'verify' | 'moderator_propose' | 'moderator_appoint';

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

/**
 * One pending moderator proposal (staff list only; not the public chain).
 *
 * Pending means a stored `moderator_propose` whose live subject is still
 * `verified` and has no `moderator_confirm` or `moderator_appoint`.
 */
export interface ModeratorProposal {
  /** Live subject; role is always `verified` for a pending row. */
  subject: { id: string; name: string | null; role: 'verified' };
  /** Propose-edge actor; missing account → `{ id, name: null }`. */
  proposedBy: TrustActorRef;
  /** Propose-edge creation time (epoch ms). */
  createdAt: number;
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
 * Whether `role` may run staff trust routes (minimum `moderator`).
 *
 * @param role - Exclusive account role.
 * @returns `true` when `roleAtLeast(role, 'moderator')`.
 */
export function isStaffRole(role: AccountRole): boolean {
  return roleAtLeast(role, 'moderator');
}

/**
 * Project stored accounts and edges to the public trust graph.
 *
 * Nodes are accounts whose role is `founder`, `moderator`, or `verified`
 * (never `basis`), sorted founder → moderator → verified, then oldest
 * `createdAt`, then `id`. Groups stored edges by `subjectId` and projects
 * at most one incoming kind per subject: the oldest eligible sibling
 * (`createdAt` then `id`). Eligible: `verify`, `moderator_appoint`, and
 * `moderator_propose` only when the live subject is a `moderator`.
 * `moderator_confirm` never. A pending propose (subject still `verified`)
 * stays private. Later appoint, confirm, or propose do not replace an
 * earlier eligible contact. Actor and subject must both be in the node
 * set. No synthetic edges. Lightning addresses, view keys, and linking
 * keys are omitted.
 *
 * @param accounts - Live accounts (roles as stored).
 * @param edges - Stored trust edges (any order).
 * @returns Public `{ nodes, edges }`.
 */
export function buildTrustChain(
  accounts: readonly Account[],
  edges: readonly TrustEdge[],
): TrustChain {
  const chainAccounts = accounts.filter(isChainAccount).slice().sort(compareChainAccounts);
  const nodeIds = new Set(chainAccounts.map((account) => account.id));
  const nodes: TrustChainNode[] = chainAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    role: account.role,
  }));
  const byId = new Map(chainAccounts.map((account) => [account.id, account]));
  const grouped = new Map<string, TrustEdge[]>();
  for (const edge of edges) {
    const siblings = grouped.get(edge.subjectId);
    if (siblings === undefined) {
      grouped.set(edge.subjectId, [edge]);
    } else {
      siblings.push(edge);
    }
  }
  const publicEdges: TrustChainEdge[] = [];
  for (const edge of edges) {
    const siblings = grouped.get(edge.subjectId);
    /* v8 ignore next 3 -- every edge was just inserted into grouped by subjectId */
    if (siblings === undefined) {
      continue;
    }
    if (!isProjectedTrustEdge(edge, byId.get(edge.subjectId), siblings)) {
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
 * Pending moderator proposals for the staff queue.
 *
 * A row is pending when a `moderator_propose` edge exists, the live
 * subject account is `verified`, and that subject has no
 * `moderator_confirm` and no `moderator_appoint` (any actor). Missing
 * subject accounts are omitted. Several proposes for one subject keep
 * the latest by `createdAt` then `id` (same tie-break as
 * {@link accountTrust}). `proposedBy` uses live actor names; a missing
 * actor is `{ id, name: null }`. Sorted oldest `createdAt` first, then
 * propose-edge `id` (FIFO). Never includes `basis` / `moderator` /
 * `founder` subjects. Pure; no I/O.
 *
 * @param accounts - Live accounts (subject role + actor names).
 * @param edges - Stored trust edges (any order, any subjects).
 * @returns Pending proposals, oldest first.
 */
export function pendingModeratorProposals(
  accounts: readonly Account[],
  edges: readonly TrustEdge[],
): ModeratorProposal[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const closed = new Set<string>();
  const latestPropose = new Map<string, TrustEdge>();
  for (const edge of edges) {
    if (edge.kind === 'moderator_confirm' || edge.kind === 'moderator_appoint') {
      closed.add(edge.subjectId);
      continue;
    }
    if (edge.kind !== 'moderator_propose') {
      continue;
    }
    const prev = latestPropose.get(edge.subjectId);
    if (
      prev === undefined ||
      edge.createdAt > prev.createdAt ||
      (edge.createdAt === prev.createdAt && edge.id > prev.id)
    ) {
      latestPropose.set(edge.subjectId, edge);
    }
  }
  const pending: { edge: TrustEdge; account: Account }[] = [];
  for (const edge of latestPropose.values()) {
    if (closed.has(edge.subjectId)) {
      continue;
    }
    const account = byId.get(edge.subjectId);
    if (account === undefined || account.role !== 'verified') {
      continue;
    }
    pending.push({ edge, account });
  }
  pending.sort((a, b) => compareTrustEdgesOldestFirst(a.edge, b.edge));
  return pending.map(({ edge, account }) => ({
    subject: { id: account.id, name: account.name, role: 'verified' },
    proposedBy: { id: edge.actorId, name: byId.get(edge.actorId)?.name ?? null },
    createdAt: edge.createdAt,
  }));
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

/**
 * True when `account.role` appears on the public chain.
 *
 * @param account - Live account (any role).
 * @returns `true` when `roleAtLeast(account.role, 'verified')`.
 */
export function isChainAccount(
  account: Account,
): account is Account & { role: TrustChainNode['role'] } {
  return roleAtLeast(account.role, 'verified');
}

/**
 * Whether a stored edge appears on the public trust chain.
 *
 * True iff `edge.kind` is the oldest eligible kind among `subjectEdges`
 * (default `[edge]`), by `createdAt` then `id`. Eligible: `verify`,
 * `moderator_appoint`, and `moderator_propose` only when the live subject
 * is a `moderator`. `moderator_confirm` never. Later siblings do not
 * replace an earlier eligible contact.
 *
 * @param edge - Stored grant.
 * @param subject - Live subject account, if loaded.
 * @param subjectEdges - Stored edges for this subject (default `[edge]`).
 * @returns `true` when the edge is the public incoming kind.
 */
export function isProjectedTrustEdge(
  edge: TrustEdge,
  subject: Account | undefined,
  subjectEdges: readonly TrustEdge[] = [edge],
): edge is TrustEdge & { kind: TrustChainKind } {
  const winning = winningPublicKind(subject, subjectEdges);
  return winning !== undefined && edge.kind === winning;
}

/** Oldest eligible public incoming kind among `subjectEdges`, or none. */
function winningPublicKind(
  subject: Account | undefined,
  subjectEdges: readonly TrustEdge[],
): TrustChainKind | undefined {
  const eligible: TrustEdge[] = [];
  for (const sibling of subjectEdges) {
    if (sibling.kind === 'moderator_confirm') {
      continue;
    }
    if (sibling.kind === 'moderator_propose' && subject?.role !== 'moderator') {
      continue;
    }
    if (
      sibling.kind === 'verify' ||
      sibling.kind === 'moderator_appoint' ||
      sibling.kind === 'moderator_propose'
    ) {
      eligible.push(sibling);
    }
  }
  if (eligible.length === 0) {
    return undefined;
  }
  const oldest = eligible.slice().sort(compareTrustEdgesOldestFirst)[0];
  /* v8 ignore next 3 -- eligible.length === 0 already returned */
  if (oldest === undefined) {
    return undefined;
  }
  /* v8 ignore next -- confirm was filtered from eligible */
  return oldest.kind === 'moderator_confirm' ? undefined : oldest.kind;
}

/** Oldest `createdAt` first, then `id`. */
function compareTrustEdgesOldestFirst(a: TrustEdge, b: TrustEdge): number {
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
