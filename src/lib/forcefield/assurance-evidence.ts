/**
 * Forcefield assurance - the evidence gatherer.
 *
 * Every control in assurance.ts names the evidence that proves it ran. This file
 * owns those queries: each one is read-only, windowed, and runs through an
 * executor that THROWS on failure, so a missing table or a dead connection reads
 * as "unknown" rather than silently as "none" (safeQuery would swallow it).
 *
 * It also runs the one sample that needs data: the tripwire self-test, which
 * drives the live caller's action shape through the real (pure)
 * inspectAgentAction + containmentFor against the workspace's ACTIVE canaries.
 * No side effects: the self-test never revokes, records, or alerts.
 */
import { hasDatabase, query } from "@/lib/db";
import { inspectAgentAction, containmentFor, type Canary, type CanaryKind } from "@/lib/forcefield/tripwire";
import { runEvidenceProbe, type EvidenceExecutor, type EvidenceProbe, type ProbeSpec } from "@/lib/compliance/evidence-window";
import type { AssuranceEvidenceKey, TripwireSelfTest } from "@/lib/forcefield/assurance";

/** The Forcefield site key this deployment records its own traffic under. It
 *  must match the `site` middleware.ts passes to the Forcefield shim; a test
 *  guards the two against drift. */
export const ASSURANCE_SITE = "instinct";

/** Windows, by how often each control should fire on a live deployment. */
export const WINDOWS = {
  block: 7,
  trap: 30,
  hostile: 30,
  alert: 30,
  autoblock: 7,
  delegation: 30,
  reputation: 30,
  agentDispatch: 7,
  chain: 1,
  anchor: 7,
} as const;

const W = (n: string) => `now() - ($${n} || ' days')::interval`;

/** The probe specs, keyed. Exported so a test can assert every key has one and
 *  a DB test can run them against a real schema. `$1` window, `$2` lookback. */
export function assuranceProbeSpecs(workspaceId: string, site: string = ASSURANCE_SITE): Record<AssuranceEvidenceKey, ProbeSpec> {
  return {
    "ff.inline_block": {
      key: "ff.inline_block",
      proof: `site_analytics_events with blocked=true on site=${site}`,
      windowDays: WINDOWS.block,
      sql: `SELECT count(*) FILTER (WHERE created_at > ${W("1")}) AS n, max(created_at) AS last
              FROM site_analytics_events
             WHERE props->>'site' = $3 AND props->>'blocked' = 'true' AND created_at > ${W("2")}`,
      params: [site],
    },
    "ff.trap_tripped": {
      key: "ff.trap_tripped",
      proof: `site.agent_trap_tripped events on site=${site}`,
      windowDays: WINDOWS.trap,
      sql: `SELECT count(*) FILTER (WHERE created_at > ${W("1")}) AS n, max(created_at) AS last
              FROM site_analytics_events
             WHERE event_type = 'site.agent_trap_tripped' AND props->>'site' = $3 AND created_at > ${W("2")}`,
      params: [site],
    },
    "ff.hostile_events": {
      key: "ff.hostile_events",
      proof: "site.agent_trap_tripped or site.agent_payload_attack events on any monitored site",
      windowDays: WINDOWS.hostile,
      sql: `SELECT count(*) FILTER (WHERE created_at > ${W("1")}) AS n, max(created_at) AS last
              FROM site_analytics_events
             WHERE event_type IN ('site.agent_trap_tripped', 'site.agent_payload_attack') AND created_at > ${W("2")}`,
    },
    "ff.alert_dispatched": {
      key: "ff.alert_dispatched",
      proof: "forcefield.web_alert_dispatched analytics events",
      windowDays: WINDOWS.alert,
      sql: `SELECT count(*) FILTER (WHERE "timestamp" > ${W("1")}) AS n, max("timestamp") AS last
              FROM instinct_events
             WHERE event_type = 'forcefield.web_alert_dispatched' AND "timestamp" > ${W("2")}`,
    },
    "ff.autoblock_fired": {
      key: "ff.autoblock_fired",
      proof: "forcefield.signature_autoblocked or forcefield.fingerprint_autoblocked events",
      windowDays: WINDOWS.autoblock,
      sql: `SELECT count(*) FILTER (WHERE "timestamp" > ${W("1")}) AS n, max("timestamp") AS last
              FROM instinct_events
             WHERE event_type IN ('forcefield.signature_autoblocked', 'forcefield.fingerprint_autoblocked') AND "timestamp" > ${W("2")}`,
    },
    "ff.delegation_verified": {
      key: "ff.delegation_verified",
      proof: "instinct_delegation_replay rows (a verified delegation consumed its jti)",
      windowDays: WINDOWS.delegation,
      sql: `SELECT count(*) FILTER (WHERE seen_at > ${W("1")}) AS n, max(seen_at) AS last
              FROM instinct_delegation_replay
             WHERE workspace_id = $3 AND seen_at > ${W("2")}`,
      params: [workspaceId],
    },
    "ff.reputation_signal": {
      key: "ff.reputation_signal",
      proof: "instinct_operator_reputation rows updated (the shared network carries signal)",
      windowDays: WINDOWS.reputation,
      // Network-wide on purpose: the reputation network is cross-workspace by
      // design; only aggregate counts are read, never another workspace's rows.
      sql: `SELECT count(*) FILTER (WHERE updated_at > ${W("1")}) AS n, max(updated_at) AS last
              FROM instinct_operator_reputation
             WHERE updated_at > ${W("2")}`,
    },
    "ff.agent_dispatch": {
      key: "ff.agent_dispatch",
      proof: "ogiam_decisions on surface=/agent (an agent tool call reached the dispatcher, where the tripwire runs)",
      windowDays: WINDOWS.agentDispatch,
      sql: `SELECT count(*) FILTER (WHERE created_at > ${W("1")}) AS n, max(created_at) AS last
              FROM ogiam_decisions
             WHERE workspace_id = $3 AND surface = '/agent' AND created_at > ${W("2")}`,
      params: [workspaceId],
    },
    "audit.chain_verified": {
      key: "audit.chain_verified",
      proof: "audit.chain_verified events with valid=true, and the newest verification passed",
      windowDays: WINDOWS.chain,
      sql: `WITH latest AS (
              SELECT (metadata->>'valid') = 'true' AS ok
                FROM instinct_events
               WHERE event_type = 'audit.chain_verified'
               ORDER BY "timestamp" DESC
               LIMIT 1)
            SELECT CASE WHEN coalesce((SELECT ok FROM latest), false)
                        THEN count(*) FILTER (WHERE "timestamp" > ${W("1")}) ELSE 0 END AS n,
                   max("timestamp") AS last
              FROM instinct_events
             WHERE event_type = 'audit.chain_verified' AND metadata->>'valid' = 'true' AND "timestamp" > ${W("2")}`,
    },
    "audit.external_anchor": {
      key: "audit.external_anchor",
      proof: "instinct_audit_external_anchors rows (chain head published to an external witness)",
      windowDays: WINDOWS.anchor,
      sql: `SELECT count(*) FILTER (WHERE published_at > ${W("1")}) AS n, max(published_at) AS last
              FROM instinct_audit_external_anchors
             WHERE published_at > ${W("2")}`,
    },
  };
}

/**
 * The tripwire self-test. The live caller (src/lib/assistant/tools/dispatcher.ts)
 * sends `{ kind: "tool_call", tool: <a REGISTERED tool>, payload: <JSON args> }`.
 * So, of the four canary kinds, only a token canary can ever reach the tripwire
 * there: route and row canaries need `url` / `rowIds` the caller never sends, and
 * a decoy tool name is random, so the registry lookup fails before the guard
 * runs. Each reachable canary is driven through the REAL inspectAgentAction and
 * containmentFor; it passes only if the decision is quarantine.
 */
export function tripwireSelfTest(canaries: readonly Canary[]): TripwireSelfTest {
  const reachableKinds: readonly CanaryKind[] = ["token"];
  const reachable = canaries.filter((c) => reachableKinds.includes(c.kind));
  const unreachableKinds = [...new Set(canaries.filter((c) => !reachableKinds.includes(c.kind)).map((c) => c.kind))].sort();
  let tripped = 0;
  for (const c of reachable) {
    const action = {
      workspaceId: "assurance-selftest",
      agentId: "assurance.selftest",
      kind: "tool_call" as const,
      tool: "assurance_selftest_tool",
      payload: JSON.stringify({ note: `selftest ${c.value} end` }),
    };
    const verdict = inspectAgentAction(action, [c]);
    if (verdict.tripped && containmentFor(verdict, action).action === "quarantine") tripped++;
  }
  return { reachable: reachable.length, tripped, unreachableKinds };
}

/** The real executor: throws on failure, null when no database is configured. */
export function liveEvidenceExecutor(): EvidenceExecutor | null {
  if (!hasDatabase()) return null;
  return async (sql, params) => query(sql, params);
}

export interface AssuranceEvidence {
  probes: Record<AssuranceEvidenceKey, EvidenceProbe>;
  tripwire: TripwireSelfTest | null;
}

/** Gather every probe + the tripwire self-test. Never throws. */
export async function collectAssuranceEvidence(
  workspaceId: string,
  exec: EvidenceExecutor | null = liveEvidenceExecutor(),
  nowMs: number = Date.now(),
): Promise<AssuranceEvidence> {
  const specs = assuranceProbeSpecs(workspaceId);
  const keys = Object.keys(specs) as AssuranceEvidenceKey[];
  const [results, tripwire] = await Promise.all([
    Promise.all(keys.map((k) => runEvidenceProbe(specs[k], exec, nowMs))),
    (async (): Promise<TripwireSelfTest | null> => {
      if (!exec) return null;
      try {
        const res = await exec(
          `SELECT id, kind, value, seeded_in FROM instinct_forcefield_canaries WHERE workspace_id = $1 AND active = true`,
          [workspaceId],
        );
        const canaries: Canary[] = res.rows.map((r) => ({
          id: String(r.id),
          kind: r.kind as CanaryKind,
          value: String(r.value ?? ""),
          seededIn: String(r.seeded_in ?? ""),
        }));
        return tripwireSelfTest(canaries);
      } catch {
        return null;
      }
    })(),
  ]);
  const probes = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as Record<AssuranceEvidenceKey, EvidenceProbe>;
  return { probes, tripwire };
}
