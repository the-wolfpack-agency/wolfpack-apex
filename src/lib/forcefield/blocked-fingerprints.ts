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
 * AUTOMATIC blocks (a honeytoken trip, a learned-signature match) are held to a
 * stricter bar than an admin's, because no human looked:
 *   1. They pass the edge policy (enforce mode + auto_block on) AND
 *      qualifiesForAutoBlock (proven-hostile only, never an inferred grouping).
 *   2. They EXPIRE: expires_at = last sighting + AUTO_BLOCK_TTL_DAYS. An expired
 *      row no longer enforces. Admin (human) blocks have no expiry.
 *   3. They are CAPPED: an operator key is a coarse behavioral bucket, so one
 *      key that resolves to more than AUTO_BLOCK_MAX_FINGERPRINTS fingerprints
 *      blocks only the fingerprints that themselves carried proof (a trap trip,
 *      a payload attack, a honeypot field), and records forcefield.autoblock_capped.
 *
 * Fail-safe: every function degrades to a no-op / empty result on a DB error, so
 * a resolution failure can neither block a legitimate admin action nor, more
 * importantly, cause the ruleset to serve a bad block list.
 */
import { query } from "@/lib/db";
import { trackEvent, trackEventAwait } from "@/lib/analytics";
import { buildJourneys } from "@/lib/agent-behavior";
import { buildAgentProfile } from "@/lib/agent-profile";
import { listBlockedOperatorKeys } from "@/lib/agent-operators";
import { getEdgePolicy, type EdgePolicy } from "@/lib/forcefield/edge-policy";
import { qualifiesForAutoBlock, AUTO_BLOCK_TTL_DAYS, type EdgeSignals } from "@/lib/forcefield/edge-enforcement";

const LOOKBACK_DAYS = 30;
const MAX_EVENTS = 5000;

/** How long an automatic block lasts after the fingerprint was last seen
 *  (defined once in edge-enforcement, re-exported for callers here). */
export { AUTO_BLOCK_TTL_DAYS };

/**
 * The most fingerprints ONE automatic operator block may fan out to without
 * per-fingerprint proof. Chosen from production (read-only, 2026-10-24):
 *   - every correlation key (nonce / sig) maps to exactly 1 fingerprint (p99 = 1,
 *     max = 1, 4,241 keys over 30 days), so a real single actor is small;
 *   - the two operators an admin reviewed and blocked resolved to 17 and 4;
 *   - the one learned auto-block resolved to 101, from 40 countries in 7 days,
 *     which is a coarse bucket, not an actor.
 * 20 sits just above the largest human-reviewed block and far below the bucket.
 */
export const AUTO_BLOCK_MAX_FINGERPRINTS = 20;

/** Event types that prove the client that sent them is a bot: a decoy only a
 *  bot reaches, a live attack payload, a hidden form field only a bot fills. */
export const PROOF_EVENT_TYPES: ReadonlySet<string> = new Set([
  "site.agent_trap_tripped",
  "site.agent_payload_attack",
  "site.agent_form_honeypot",
]);

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

/** What we know about one fingerprint from recent events. */
export interface FingerprintEvidence {
  fp: string;
  /** ISO time of its most recent event. */
  lastSeen: string;
  /** True when this fingerprint itself sent a PROOF event. */
  proven: boolean;
}

/** Load recent fingerprinted events and correlate them into journeys, exactly
 *  as the board does. Returns the journeys, a key -> fp-set map (a journey's
 *  correlation key groups the events that carry its fingerprints) and per-fp
 *  evidence (last seen + whether it carried proof). */
async function loadJourneysWithFingerprints(): Promise<{
  journeys: ReturnType<typeof buildJourneys> extends Array<infer T> ? Array<T & { operatorKey: string }> : never;
  fpByKey: Map<string, Set<string>>;
  evidence: Map<string, FingerprintEvidence>;
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
  const evidence = new Map<string, FingerprintEvidence>();
  const rows = res.rows.map((r) => {
    const nonce = r.nonce ?? undefined;
    const key = nonce ?? r.sig ?? "";
    if (key && r.fp) {
      let set = fpByKey.get(key);
      if (!set) fpByKey.set(key, (set = new Set()));
      set.add(r.fp);
    }
    if (r.fp) {
      const at = new Date(r.created_at).toISOString();
      const prev = evidence.get(r.fp);
      const proven = PROOF_EVENT_TYPES.has(r.event_type);
      if (!prev) evidence.set(r.fp, { fp: r.fp, lastSeen: at, proven });
      else {
        if (at > prev.lastSeen) prev.lastSeen = at;
        if (proven) prev.proven = true;
      }
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
  return { journeys: journeys as any, fpByKey, evidence };
}

/** Per-fingerprint evidence for one operator, from recent events. Empty on any
 *  DB error (fail-safe). */
export async function resolveOperatorEvidence(operatorKey: string): Promise<FingerprintEvidence[]> {
  try {
    const { journeys, fpByKey, evidence } = await loadJourneysWithFingerprints();
    const fps = new Set<string>();
    for (const j of journeys) {
      if (j.operatorKey !== operatorKey) continue;
      const set = fpByKey.get(j.key);
      if (set) for (const fp of set) fps.add(fp);
    }
    return [...fps].map((fp) => evidence.get(fp) ?? { fp, lastSeen: new Date().toISOString(), proven: false });
  } catch {
    return [];
  }
}

/** The stable fingerprints an operator has been observed using, from recent
 *  events. Empty on any DB error (fail-safe). */
export async function resolveOperatorFingerprints(operatorKey: string): Promise<string[]> {
  return (await resolveOperatorEvidence(operatorKey)).map((e) => e.fp);
}

/* ------------------------------ pure planning ----------------------------- */

export interface AutoBlockPlan {
  /** Fingerprints to write, each with its own expiry. */
  rows: { fp: string; expiresAt: string }[];
  /** True when the operator resolved to more than the cap. */
  capped: boolean;
  resolved: number;
  proven: number;
  /** Fingerprints dropped because they were last seen longer ago than the TTL. */
  stale: number;
}

/**
 * Decide which of an operator's fingerprints an AUTOMATIC block may write.
 * Pure + deterministic:
 *   - a fingerprint last seen more than ttlDays ago is not blocked (it would be
 *     expired on arrival);
 *   - over the cap, only fingerprints that carried proof are kept;
 *   - each row expires ttlDays after that fingerprint's last sighting.
 */
export function planOperatorAutoBlock(
  evidence: readonly FingerprintEvidence[],
  opts: { now?: Date; ttlDays?: number; cap?: number } = {},
): AutoBlockPlan {
  const now = opts.now ?? new Date();
  const ttlMs = (opts.ttlDays ?? AUTO_BLOCK_TTL_DAYS) * 86_400_000;
  const cap = opts.cap ?? AUTO_BLOCK_MAX_FINGERPRINTS;
  const fresh = evidence.filter((e) => now.getTime() - new Date(e.lastSeen).getTime() < ttlMs);
  const capped = fresh.length > cap;
  const kept = capped ? fresh.filter((e) => e.proven) : fresh;
  return {
    rows: kept.map((e) => ({ fp: e.fp, expiresAt: new Date(new Date(e.lastSeen).getTime() + ttlMs).toISOString() })),
    capped,
    resolved: fresh.length,
    proven: fresh.filter((e) => e.proven).length,
    stale: evidence.length - fresh.length,
  };
}

/** True when a stored row still enforces: admin rows (no expiry) always do,
 *  automatic rows only until expires_at. */
export function isBlockActive(expiresAt: string | Date | null | undefined, now = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;
  return new Date(expiresAt).getTime() > now.getTime();
}

/* ------------------------------ the auto gate ----------------------------- */

export interface AutoBlockGateInput {
  workspaceId: string;
  /** Proven-hostile (pinned by proof, not inferred from a coarse grouping). */
  proven: boolean;
  trustBand: EdgeSignals["trustBand"];
  principalStatus?: EdgeSignals["principalStatus"];
  mandateExceeded?: boolean;
  /** For the skipped event. */
  reason: string;
}

export interface AutoBlockGateResult {
  allowed: boolean;
  why: string;
  policy: EdgePolicy;
}

/**
 * The single gate every AUTOMATIC block passes: the edge policy must be in
 * enforce mode with auto_block on, and qualifiesForAutoBlock must say yes. A
 * refusal is recorded (forcefield.autoblock_skipped), never silent.
 */
export async function gateAutoBlock(input: AutoBlockGateInput, deps: { getPolicy?: (ws: string) => Promise<EdgePolicy> } = {}): Promise<AutoBlockGateResult> {
  let policy: EdgePolicy = { mode: "monitor", autoBlock: false };
  try {
    policy = await (deps.getPolicy ?? getEdgePolicy)(input.workspaceId);
  } catch {
    /* fail closed: monitor + no auto-block */
  }
  let allowed = false;
  let why: string;
  if (policy.mode !== "enforce" || !policy.autoBlock) {
    why = `edge policy is ${policy.mode} with auto_block ${policy.autoBlock ? "on" : "off"}`;
  } else {
    const verdict = qualifiesForAutoBlock(
      {
        blocked: false,
        trustBand: input.trustBand,
        mandateExceeded: input.mandateExceeded === true,
        principalStatus: input.principalStatus ?? "absent",
        networkHostile: false,
      },
      { proven: input.proven },
    );
    allowed = verdict.auto;
    why = verdict.reason;
  }
  if (!allowed) {
    trackEvent("forcefield.autoblock_skipped", "system", "forcefield", {
      reason: input.reason,
      why,
      mode: policy.mode,
      auto_block: policy.autoBlock,
      proven: input.proven,
      trust_band: input.trustBand,
    });
  }
  return { allowed, why, policy };
}

/* --------------------------------- writes --------------------------------- */

/** Capture + persist a blocked operator's fingerprints (an ADMIN block: no
 *  expiry). Idempotent (upsert). Returns the rows actually inserted. */
export async function captureBlockedFingerprints(workspaceId: string, operatorKey: string): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  const fps = await resolveOperatorFingerprints(operatorKey);
  if (fps.length === 0) return 0;
  try {
    // A human block never expires: clear any expiry a prior automatic write left.
    const res = await query<{ inserted: boolean }>(
      `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp, expires_at)
         SELECT $1, $2, unnest($3::text[]), NULL
       ON CONFLICT (workspace_id, operator_key, fp) DO UPDATE SET expires_at = NULL
       RETURNING (xmax = 0) AS inserted`,
      [workspaceId, operatorKey, fps],
    );
    return res.rows.filter((r) => r.inserted).length;
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

/** Upsert automatic rows: insert new ones, extend an existing row's expiry to
 *  the later of the two (a fresh sighting re-arms it). Returns NEW rows only. */
async function writeAutoRows(workspaceId: string, opKey: string, rows: { fp: string; expiresAt: string }[]): Promise<{ inserted: number; refreshed: number }> {
  const res = await query<{ inserted: boolean }>(
    `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp, expires_at)
       SELECT $1, $2, f.fp, f.expires_at
         FROM unnest($3::text[], $4::timestamptz[]) AS f(fp, expires_at)
     ON CONFLICT (workspace_id, operator_key, fp) DO UPDATE
       SET expires_at = GREATEST(instinct_agent_blocked_fingerprints.expires_at, EXCLUDED.expires_at)
     WHERE instinct_agent_blocked_fingerprints.expires_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [workspaceId, opKey, rows.map((r) => r.fp), rows.map((r) => r.expiresAt)],
  );
  const inserted = res.rows.filter((r) => r.inserted).length;
  return { inserted, refreshed: res.rows.length - inserted };
}

/** Auto-block a client fingerprint that tripped a honeytoken - the highest-
 *  confidence hostile signal. Passes the edge policy + qualifiesForAutoBlock
 *  (proven, hostile), is written under a reserved "auto:<reason>" key, and
 *  expires AUTO_BLOCK_TTL_DAYS after this sighting. Returns rows inserted.
 *  Fail-safe + idempotent; never throws. */
export async function autoBlockFingerprint(fp: string, reason: string): Promise<number> {
  if (!process.env.DATABASE_URL || !fp) return 0;
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  try {
    const gate = await gateAutoBlock({ workspaceId, proven: true, trustBand: "hostile", reason: `auto:${reason}` });
    if (!gate.allowed) return 0;
    const expiresAt = new Date(Date.now() + AUTO_BLOCK_TTL_DAYS * 86_400_000).toISOString();
    const { inserted } = await writeAutoRows(workspaceId, `auto:${reason}`, [{ fp, expiresAt }]);
    if (inserted > 0) trackEvent("forcefield.fingerprint_autoblocked", "system", "forcefield", { fp, reason, expires_at: expiresAt });
    return inserted;
  } catch (err) {
    console.warn("[blocked-fingerprints] auto-block failed:", (err as Error).message);
    return 0;
  }
}

export interface AutoBlockOperatorInput {
  /** Whether the operator is proven-hostile (dossier confidence "proven"). */
  proven: boolean;
  trustBand: EdgeSignals["trustBand"];
  principalStatus?: EdgeSignals["principalStatus"];
}

/** Auto-block a whole OPERATOR (a behavioral cluster, not a single fp). Gated
 *  (edge policy + qualifiesForAutoBlock), capped, and expiring - see the file
 *  header. Used by the learned-signature loop when a live operator matches an
 *  ENFORCING signature. Fail-safe + idempotent; returns the number of
 *  fingerprint rows NEWLY inserted (0 on a re-run that added nothing). */
export async function autoBlockOperator(operatorKey: string, reason: string, input: AutoBlockOperatorInput = { proven: false, trustBand: "caution" }): Promise<number> {
  if (!process.env.DATABASE_URL || !operatorKey) return 0;
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  const opKey = `auto:${reason}`;
  try {
    const gate = await gateAutoBlock({ workspaceId, proven: input.proven, trustBand: input.trustBand, principalStatus: input.principalStatus, reason: opKey });
    if (!gate.allowed) return 0;
    const evidence = await resolveOperatorEvidence(operatorKey);
    if (evidence.length === 0) return 0;
    const plan = planOperatorAutoBlock(evidence);
    if (plan.capped) {
      await trackEventAwait("forcefield.autoblock_capped", "system", "forcefield", {
        operatorKey,
        reason,
        resolved: plan.resolved,
        proven: plan.proven,
        cap: AUTO_BLOCK_MAX_FINGERPRINTS,
      });
    }
    if (plan.rows.length === 0) return 0;
    const { inserted } = await writeAutoRows(workspaceId, opKey, plan.rows);
    if (inserted > 0) trackEvent("forcefield.fingerprint_autoblocked", "system", "forcefield", { operatorKey, reason, count: inserted, capped: plan.capped });
    return inserted;
  } catch (err) {
    console.warn("[blocked-fingerprints] auto-block operator failed:", (err as Error).message);
    return 0;
  }
}

/* --------------------------------- reads ---------------------------------- */

/** The distinct fingerprints to distribute for a workspace. A row enforces only
 *  while it is unexpired; an admin row only while its operator is still blocked;
 *  an automatic row only while the edge policy still allows auto-blocking (so
 *  turning auto_block off withdraws every automatic block at once). Empty on any
 *  error (fail-safe: the ruleset falls back to no fingerprint enforcement rather
 *  than a wrong block). */
export async function getBlockedFingerprints(workspaceId: string, now = new Date()): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const res = await query<{ fp: string; operator_key: string; expires_at: string | null }>(
      `SELECT DISTINCT fp, operator_key, expires_at
         FROM instinct_agent_blocked_fingerprints
        WHERE workspace_id = $1
          AND (expires_at IS NULL OR expires_at > now())`,
      [workspaceId],
    );
    if (res.rows.length === 0) return [];
    const blocked = await listBlockedOperatorKeys(workspaceId);
    const hasAuto = res.rows.some((r) => r.operator_key.startsWith("auto:"));
    const policy = hasAuto ? await getEdgePolicy(workspaceId) : null;
    const autoEnforces = policy !== null && policy.mode === "enforce" && policy.autoBlock;
    const out = new Set<string>();
    for (const r of res.rows) {
      if (!isBlockActive(r.expires_at, now)) continue;
      if (r.operator_key.startsWith("auto:") ? autoEnforces : blocked.has(r.operator_key)) out.add(r.fp);
    }
    return [...out];
  } catch {
    return [];
  }
}
