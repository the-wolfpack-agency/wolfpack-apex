/**
 * Distributed operator-block enforcement - the SENDING half.
 *
 * When an admin blocks an operator on the board, we resolve that operator's
 * stable per-request fingerprints (fp) from recent events and store them, so the
 * central ruleset can distribute them to every connected site. The edge then
 * turns that operator away pre-emptively (see forcefield-web/enforce.ts, which
 * only acts on a fingerprint for a NON-browser client - a real visitor is never
 * caught by a collision).
 *
 * The operator <-> fingerprint mapping is BEHAVIORAL: an operator is a cluster
 * of correlated sessions, not a single request. So we rebuild the same journeys
 * the board shows (buildJourneys + buildAgentProfile), match the operator key,
 * and collect the fp of the events in its sessions. Non-PII throughout: fp is a
 * header-order hash, never an identity.
 *
 * Fail-safe: every function degrades to a no-op / empty result on a DB error, so
 * a resolution failure can neither block a legitimate admin action nor, more
 * importantly, cause the ruleset to serve a bad block list.
 */
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { buildJourneys } from "@/lib/agent-behavior";
import { buildAgentProfile } from "@/lib/agent-profile";
import { listBlockedOperatorKeys } from "@/lib/agent-operators";

const LOOKBACK_DAYS = 30;
const MAX_EVENTS = 5000;

type EventRow = {
  event_type: string;
  path: string | null;
  created_at: string;
  sig: string | null;
  nonce: string | null;
  fp: string | null;
  agent: string | null;
  attack: string | null;
  tool: string | null;
  client_type: string | null;
};

/** Load recent fingerprinted events and correlate them into journeys, exactly
 *  as the board does. Returns the journeys plus a key -> fp-set map (a journey's
 *  correlation key groups the events that carry its fingerprints). */
async function loadJourneysWithFingerprints(): Promise<{
  journeys: ReturnType<typeof buildJourneys> extends Array<infer T> ? Array<T & { operatorKey: string }> : never;
  fpByKey: Map<string, Set<string>>;
}> {
  const res = await query<EventRow>(
    `SELECT event_type, path, created_at::text AS created_at,
            props->>'sig' AS sig, props->>'nonce' AS nonce, props->>'fp' AS fp,
            props->>'agent' AS agent, props->>'attack' AS attack,
            props->>'tool' AS tool, props->>'client_type' AS client_type
       FROM site_analytics_events
      WHERE created_at > now() - ($1 || ' days')::interval
        AND props->>'fp' IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [String(LOOKBACK_DAYS), MAX_EVENTS],
  );

  const fpByKey = new Map<string, Set<string>>();
  const rows = res.rows.map((r) => {
    const nonce = r.nonce ?? undefined;
    const key = nonce ?? r.sig ?? "";
    if (key && r.fp) {
      let set = fpByKey.get(key);
      if (!set) fpByKey.set(key, (set = new Set()));
      set.add(r.fp);
    }
    return {
      key,
      keyKind: (nonce ? "nonce" : "fingerprint") as "nonce" | "fingerprint",
      type: r.event_type,
      path: r.path ?? "",
      at: r.created_at,
      nonceLinked: !!nonce,
      agent: r.agent ?? undefined,
      attack: r.attack ?? undefined,
      tool: r.tool ?? undefined,
      clientType: r.client_type ?? undefined,
    };
  }).filter((r) => r.key !== "");

  const journeys = buildJourneys(rows).map((j) => ({ ...j, operatorKey: buildAgentProfile(j).operatorKey }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { journeys: journeys as any, fpByKey };
}

/** The stable fingerprints an operator has been observed using, from recent
 *  events. Empty on any DB error (fail-safe). */
export async function resolveOperatorFingerprints(operatorKey: string): Promise<string[]> {
  try {
    const { journeys, fpByKey } = await loadJourneysWithFingerprints();
    const fps = new Set<string>();
    for (const j of journeys) {
      if (j.operatorKey !== operatorKey) continue;
      const set = fpByKey.get(j.key);
      if (set) for (const fp of set) fps.add(fp);
    }
    return [...fps];
  } catch {
    return [];
  }
}

/** Capture + persist a blocked operator's fingerprints. Idempotent (upsert). */
export async function captureBlockedFingerprints(workspaceId: string, operatorKey: string): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  const fps = await resolveOperatorFingerprints(operatorKey);
  if (fps.length === 0) return 0;
  try {
    await query(
      `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp)
         SELECT $1, $2, unnest($3::text[])
       ON CONFLICT (workspace_id, operator_key, fp) DO NOTHING`,
      [workspaceId, operatorKey, fps],
    );
    return fps.length;
  } catch (err) {
    console.warn("[blocked-fingerprints] capture failed:", (err as Error).message);
    return 0;
  }
}

/** Drop a specific operator's blocked fingerprints (on unblock). */
export async function clearBlockedFingerprints(workspaceId: string, operatorKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(`DELETE FROM instinct_agent_blocked_fingerprints WHERE workspace_id = $1 AND operator_key = $2`, [workspaceId, operatorKey]);
  } catch (err) {
    console.warn("[blocked-fingerprints] clear failed:", (err as Error).message);
  }
}

/** Auto-block a client fingerprint that tripped a honeytoken - the highest-
 *  confidence hostile signal, so no human step is needed. Written under a reserved
 *  "auto:<reason>" operator key so getBlockedFingerprints serves it unconditionally
 *  (it does not depend on an admin having blocked an operator). The central ruleset
 *  distributes it and enforce.ts turns the same fingerprint away on its next hit,
 *  across every connected site. Fail-safe + idempotent; never throws. */
export async function autoBlockFingerprint(fp: string, reason: string): Promise<void> {
  if (!process.env.DATABASE_URL || !fp) return;
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  const operatorKey = `auto:${reason}`;
  try {
    const res = await query(
      `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp)
       VALUES ($1, $2, $3) ON CONFLICT (workspace_id, operator_key, fp) DO NOTHING`,
      [workspaceId, operatorKey, fp],
    );
    if ((res.rowCount ?? 0) > 0) trackEvent("forcefield.fingerprint_autoblocked", "system", "forcefield", { fp, reason });
  } catch (err) {
    console.warn("[blocked-fingerprints] auto-block failed:", (err as Error).message);
  }
}

/** Auto-block a whole OPERATOR (a behavioral cluster, not a single fp): resolve
 *  its stable edge fingerprints and store them under a reserved "auto:<reason>"
 *  key so getBlockedFingerprints serves them unconditionally. Used by the learned-
 *  signature loop when a live operator matches an ENFORCING signature. Fail-safe +
 *  idempotent; returns the number of fingerprints written for it. */
export async function autoBlockOperator(operatorKey: string, reason: string): Promise<number> {
  if (!process.env.DATABASE_URL || !operatorKey) return 0;
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  const fps = await resolveOperatorFingerprints(operatorKey);
  if (fps.length === 0) return 0;
  const opKey = `auto:${reason}`;
  try {
    const res = await query(
      `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp)
         SELECT $1, $2, unnest($3::text[])
       ON CONFLICT (workspace_id, operator_key, fp) DO NOTHING`,
      [workspaceId, opKey, fps],
    );
    if ((res.rowCount ?? 0) > 0) trackEvent("forcefield.fingerprint_autoblocked", "system", "forcefield", { operatorKey, reason, count: res.rowCount ?? 0 });
    return fps.length;
  } catch (err) {
    console.warn("[blocked-fingerprints] auto-block operator failed:", (err as Error).message);
    return 0;
  }
}

/** The distinct fingerprints to distribute for a workspace - ONLY those whose
 *  operator is still blocked (a stale row for an unblocked operator never
 *  enforces). Empty on any error (fail-safe: the ruleset falls back to no
 *  fingerprint enforcement rather than a wrong block). */
export async function getBlockedFingerprints(workspaceId: string): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const res = await query<{ fp: string; operator_key: string }>(
      `SELECT DISTINCT fp, operator_key FROM instinct_agent_blocked_fingerprints WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (res.rows.length === 0) return [];
    // Auto-blocked (honeytoken) fingerprints enforce unconditionally; admin
    // operator blocks enforce only while that operator is still blocked (a stale
    // row for an unblocked operator never enforces).
    const blocked = await listBlockedOperatorKeys(workspaceId);
    const out = new Set<string>();
    for (const r of res.rows) if (r.operator_key.startsWith("auto:") || blocked.has(r.operator_key)) out.add(r.fp);
    return [...out];
  } catch {
    return [];
  }
}
