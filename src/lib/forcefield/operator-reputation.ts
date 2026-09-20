/**
 * Operator reputation: an OPT-IN, cross-workspace threat-intelligence network.
 *
 * The moat. Alone, each workspace only knows the operators it has seen. Opted in,
 * a workspace shares its confirmed-hostile blocks (an OPAQUE fingerprint + a
 * severity, never paths/PII/identity) and, in return, sees whether an operator
 * arriving now is already known-hostile to OTHER workspaces on the network - so a
 * bad actor caught once is flagged everywhere.
 *
 * PRIVACY, ENCODED. Off by default. A reader never learns WHICH workspaces
 * reported an operator, only an opaque fingerprint + a count + a worst-severity,
 * and the reader's OWN reports are excluded from what it reads back (so the badge
 * always means "known beyond you"). Reads fail open (empty) so the board degrades
 * rather than throwing.
 */
import { query, safeQuery, hasDatabase } from "@/lib/db";
import type { Severity } from "@/lib/agent-triage";

export interface ReputationOptIn {
  contribute: boolean;
  consume: boolean;
}

/** A workspace's opt-in state. No row = fully off (the default). */
export async function getReputationOptIn(workspaceId: string): Promise<ReputationOptIn> {
  const { rows } = await safeQuery<{ contribute: boolean; consume: boolean }>(
    `SELECT contribute, consume FROM instinct_reputation_optin WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  );
  return { contribute: rows[0]?.contribute ?? false, consume: rows[0]?.consume ?? false };
}

/** Set a workspace's opt-in. Upsert; no-op without a DB. */
export async function setReputationOptIn(
  workspaceId: string,
  optIn: ReputationOptIn,
  updatedBy?: string,
): Promise<void> {
  if (!hasDatabase()) return;
  await query(
    `INSERT INTO instinct_reputation_optin (workspace_id, contribute, consume, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (workspace_id) DO UPDATE
       SET contribute = EXCLUDED.contribute, consume = EXCLUDED.consume, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [workspaceId, optIn.contribute, optIn.consume, updatedBy ?? null],
  );
}

/**
 * Contribute a confirmed-hostile operator to the network. Called when a workspace
 * BLOCKS an operator (a deliberate, human-confirmed hostile signal). No-op unless
 * the workspace has opted in to contribute. Idempotent per (operator, workspace).
 */
export async function contributeHostileOperator(input: {
  workspaceId: string;
  operatorKey: string;
  severity?: Severity;
  behaviorClasses?: readonly string[];
  /** The specific tradecraft tells (signal names) this actor gave off. */
  tells?: readonly string[];
}): Promise<void> {
  if (!hasDatabase()) return;
  const { contribute } = await getReputationOptIn(input.workspaceId);
  if (!contribute) return; // not opted in: never share
  const severity = input.severity ?? "hostile"; // a block is a hostile confirmation
  await query(
    `INSERT INTO instinct_operator_reputation (operator_key, workspace_id, severity, behavior_classes, tells)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (operator_key, workspace_id) DO UPDATE
       SET severity = EXCLUDED.severity, behavior_classes = EXCLUDED.behavior_classes, tells = EXCLUDED.tells, updated_at = now()`,
    [input.operatorKey, input.workspaceId, severity, input.behaviorClasses ?? [], input.tells ?? []],
  );
}

export interface NetworkReputation {
  operatorKey: string;
  /** How many OTHER workspaces reported this operator (never which ones). */
  otherWorkspaces: number;
  /** Worst severity reported by other workspaces. */
  severity: Severity;
  /** Union of the tradecraft this actor showed across workspaces (behavior
   *  classes + tells), so you recognize its METHODS, not just its fingerprint. */
  ttps: string[];
}

const SEV_BY_RANK: Record<number, Severity> = { 3: "hostile", 2: "elevated", 1: "benign" };
// Sybil resistance: a SINGLE workspace (or a Sybil of one) cannot manufacture a
// "hostile" network verdict. Hostile requires at least this many DISTINCT other
// workspaces to have reported it hostile; a lone hostile report is downgraded to
// "elevated" (a challenge, never a hard block).
const HOSTILE_CORROBORATION_MIN = 2;

/**
 * Look up network reputation for a set of operators, EXCLUDING the caller's own
 * reports (so it always means "known beyond you"). No-op ({}) unless the caller
 * has opted in to consume. Fail-open. This is a deliberate cross-workspace read.
 */
export async function getNetworkReputation(
  callerWorkspaceId: string,
  operatorKeys: readonly string[],
): Promise<Record<string, NetworkReputation>> {
  if (operatorKeys.length === 0) return {};
  const { consume } = await getReputationOptIn(callerWorkspaceId);
  if (!consume) return {};
  // Cross-workspace by design: aggregate reports from workspaces OTHER than the
  // caller. Selects workspace_id (the count) but is intentionally not workspace-
  // scoped - this is the network signal.
  const { rows } = await safeQuery<{ operator_key: string; other_workspaces: string; hostile_reporters: string; sev_rank: number; ttps: string[] | null }>(
    // ttps: the union of every tradecraft signal (behavior classes + tells) this
    // actor showed across ALL reporting workspaces. LEFT JOIN LATERAL unnest so an
    // actor with empty arrays still counts toward other_workspaces; array_agg
    // DISTINCT then dedupes across the whole group. Capped to 12 in JS.
    `SELECT r.operator_key,
            count(DISTINCT r.workspace_id) AS other_workspaces,
            count(DISTINCT r.workspace_id) FILTER (WHERE r.severity = 'hostile') AS hostile_reporters,
            max(CASE r.severity WHEN 'hostile' THEN 3 WHEN 'elevated' THEN 2 ELSE 1 END) AS sev_rank,
            array_remove(array_agg(DISTINCT sig.tag), NULL) AS ttps
       FROM instinct_operator_reputation r
       LEFT JOIN LATERAL unnest(r.behavior_classes || r.tells) AS sig(tag) ON true
      WHERE r.operator_key = ANY($1) AND r.workspace_id <> $2
      GROUP BY r.operator_key`,
    [operatorKeys as string[], callerWorkspaceId],
  );
  const out: Record<string, NetworkReputation> = {};
  for (const r of rows) {
    const n = Number(r.other_workspaces);
    if (n <= 0) continue;
    const hostileReporters = Number(r.hostile_reporters);
    let severity: Severity;
    if (hostileReporters >= HOSTILE_CORROBORATION_MIN) severity = "hostile"; // corroborated
    else if (hostileReporters >= 1) severity = "elevated";                   // uncorroborated hostile -> challenge, not block
    else severity = SEV_BY_RANK[r.sev_rank] ?? "elevated";                   // elevated/benign as reported
    const ttps = (Array.isArray(r.ttps) ? r.ttps.filter((t): t is string => typeof t === "string" && t.length > 0) : []).slice(0, 12);
    out[r.operator_key] = { operatorKey: r.operator_key, otherWorkspaces: n, severity, ttps };
  }
  return out;
}
