/**
 * Forcefield canary registry - the decoys the tripwire matches against.
 *
 * Reuses the Canary shape from ./tripwire so the store and the detector cannot
 * drift. Also owns the side effects of a TRIP (recordCanaryTrip: event + audit
 * entry + alert) and the inbound-request check (checkInboundForCanaries), so
 * every call site records a trip the same way. Two read paths, on purpose:
 *   - listCanariesForMatching (INTERNAL): the full decoy values, fed straight to
 *     inspectAgentAction. Never wired to a response body.
 *   - listCanariesForDisplay (SAFE): id / kind / where-seeded + a MASKED hint.
 *     Revealing the exact decoy values would let an attacker route around the
 *     deception, so the management surface never sees them.
 */
import { createHash } from "node:crypto";
import { query, safeQuery } from "@/lib/db";
import { trackEvent, trackEventAwait } from "@/lib/analytics";
import { recordAuditNonFatal, type AuditEntryInput } from "@/lib/audit-log";
import {
  dispatchForcefieldAlert,
  liveForcefieldAlertDeps,
  windowStartOf,
  type DeliveryOutcome,
  type ForcefieldAlert,
} from "@/lib/forcefield-web/alerts";
import type { AgentAction, Canary, CanaryHit, CanaryKind, TripwireVerdict } from "./tripwire";
import { CANARY_KINDS, inspectAgentAction } from "./tripwire";

export { CANARY_KINDS };

export function isCanaryKind(v: unknown): v is CanaryKind {
  return typeof v === "string" && (CANARY_KINDS as readonly string[]).includes(v);
}

/** Safe to render: no full decoy value. */
export interface CanaryDisplay {
  id: string;
  kind: CanaryKind;
  seededIn: string;
  valueHint: string;
  active: boolean;
  createdAt: string;
}

/** A masked hint - the last 4 characters only, so an operator can recognise a
 *  decoy without the value leaving the store to defeat the deception. */
function hintOf(value: string): string {
  return `****${value.slice(-4)}`;
}

export async function createCanary(input: {
  workspaceId: string;
  kind: CanaryKind;
  value: string;
  seededIn: string;
  createdBy?: string;
}): Promise<CanaryDisplay | null> {
  if (!process.env.DATABASE_URL) return null;
  const value = (input.value ?? "").trim();
  if (!value) throw new Error("value is required");
  if (!input.seededIn?.trim()) throw new Error("seededIn is required");
  if (!isCanaryKind(input.kind)) throw new Error(`unknown canary kind: ${input.kind}`);

  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO instinct_forcefield_canaries
       (workspace_id, kind, value, seeded_in, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at::text AS created_at`,
    [input.workspaceId, input.kind, value, input.seededIn.trim(), input.createdBy ?? null],
  );
  const row = rows[0];
  if (!row) return null;

  trackEvent("forcefield.canary_seeded", input.createdBy ?? "system", "agent", {
    workspace_id: input.workspaceId,
    kind: input.kind,
    seeded_in: input.seededIn.trim(),
  });

  return {
    id: row.id,
    kind: input.kind,
    seededIn: input.seededIn.trim(),
    valueHint: hintOf(value),
    active: true,
    createdAt: row.created_at,
  };
}

/**
 * INTERNAL. The active decoys with their full values, in the tripwire's Canary
 * shape - fed straight to inspectAgentAction. Never expose this from a response.
 */
export async function listCanariesForMatching(workspaceId: string): Promise<Canary[]> {
  const res = await safeQuery<{ id: string; kind: CanaryKind; value: string; seeded_in: string }>(
    `SELECT id, kind, value, seeded_in
       FROM instinct_forcefield_canaries
      WHERE workspace_id = $1 AND active = true`,
    [workspaceId],
  );
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, value: r.value, seededIn: r.seeded_in }));
}

/** SAFE for a response body: id / kind / where-seeded + a masked hint only. */
export async function listCanariesForDisplay(workspaceId: string): Promise<CanaryDisplay[]> {
  const res = await safeQuery<{
    id: string;
    kind: CanaryKind;
    value: string;
    seeded_in: string;
    active: boolean;
    created_at: string;
  }>(
    `SELECT id, kind, value, seeded_in, active, created_at::text AS created_at
       FROM instinct_forcefield_canaries
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    seededIn: r.seeded_in,
    valueHint: hintOf(r.value),
    active: r.active,
    createdAt: r.created_at,
  }));
}

/** Retire a decoy (soft-disable so it no longer trips). */
export async function deactivateCanary(workspaceId: string, id: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const res = await query(
    `UPDATE instinct_forcefield_canaries SET active = false WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ------------------------- matching on the hot path ------------------------ */

const MATCH_CACHE_TTL_MS = 60_000;
const matchCache = new Map<string, { at: number; canaries: Canary[] }>();

/**
 * INTERNAL. listCanariesForMatching behind a 60s in-process cache, for request
 * hot paths (the edge observe route) that must not add a DB read per request.
 * A seeded or retired decoy takes effect within a minute.
 */
export async function listCanariesForMatchingCached(workspaceId: string, now = Date.now()): Promise<Canary[]> {
  const hit = matchCache.get(workspaceId);
  if (hit && now - hit.at < MATCH_CACHE_TTL_MS) return hit.canaries;
  const canaries = await listCanariesForMatching(workspaceId);
  matchCache.set(workspaceId, { at: now, canaries });
  return canaries;
}

/** Test seam: drop the hot-path cache. */
export function _resetCanaryMatchCache(): void {
  matchCache.clear();
}

/* ------------------------------ recording a trip --------------------------- */

export interface CanaryTripInput {
  workspaceId: string;
  action: AgentAction;
  hits: readonly CanaryHit[];
  /** An agent principal's id when one was involved (it is then also revoked by
   *  guardAgentAction); absent for an anonymous inbound request. */
  agentId?: string;
  /** e.g. the connected site's label, for the alert title. */
  site?: string;
}

export interface CanaryTripDeps {
  track: (payload: Record<string, string | number | boolean>) => Promise<void>;
  audit: (entry: AuditEntryInput) => Promise<{ ok: boolean }>;
  alert: (alert: ForcefieldAlert) => Promise<DeliveryOutcome | null>;
}

export function liveCanaryTripDeps(): CanaryTripDeps {
  const alertDeps = liveForcefieldAlertDeps();
  return {
    track: (payload) => trackEventAwait("forcefield.canary_tripped", "system", "forcefield", payload),
    audit: (entry) => recordAuditNonFatal(entry),
    alert: (alert) => dispatchForcefieldAlert(alert, alertDeps),
  };
}

export interface CanaryTripOutcome {
  tracked: number;
  audited: boolean;
  alert: DeliveryOutcome | null;
}

/**
 * Record a canary trip end to end: one durable forcefield.canary_tripped event
 * per hit, one hash-chained audit entry, and an alert through the Forcefield
 * alert path (deduped per canary + 6-hour window, so a burst of hits on one
 * decoy is one alert, not hundreds). HIT METADATA ONLY: the decoy value and the
 * action payload are never recorded anywhere. Never throws.
 */
export async function recordCanaryTrip(input: CanaryTripInput, deps: CanaryTripDeps = liveCanaryTripDeps()): Promise<CanaryTripOutcome> {
  const out: CanaryTripOutcome = { tracked: 0, audited: false, alert: null };
  if (input.hits.length === 0) return out;
  const who = input.agentId ? `agent ${input.agentId}` : `client ${input.action.agentId}`;

  for (const h of input.hits) {
    try {
      await deps.track({
        workspace_id: input.workspaceId,
        canary_id: h.canaryId,
        kind: h.kind,
        surface: h.surface,
        seeded_in: h.seededIn,
        action_kind: input.action.kind,
        ...(input.agentId ? { agent_id: input.agentId } : {}),
        ...(input.site ? { site: input.site } : {}),
      });
      out.tracked++;
    } catch {
      /* the audit + alert below still run */
    }
  }

  try {
    const res = await deps.audit({
      actor: { user_id: "forcefield", role: "system" },
      action: "forcefield.canary_tripped",
      resourceType: "forcefield_canary",
      resourceId: `${input.workspaceId}:${input.hits.map((h) => h.canaryId).join(",")}`,
      afterState: {
        action_kind: input.action.kind,
        agent_id: input.agentId ?? null,
        site: input.site ?? null,
        hits: input.hits.map((h) => ({ canary_id: h.canaryId, kind: h.kind, surface: h.surface, seeded_in: h.seededIn })),
      },
    });
    out.audited = res.ok;
  } catch {
    out.audited = false;
  }

  const first = input.hits[0];
  const windowStart = windowStartOf(new Date());
  const kinds = Array.from(new Set(input.hits.map((h) => h.kind))).join(", ");
  try {
    out.alert = await deps.alert({
      kind: "canary_trip",
      dedupeKey: createHash("sha256").update(["canary_trip", input.workspaceId, first.canaryId, input.agentId ?? input.action.agentId, windowStart].join("|")).digest("hex").slice(0, 24),
      title: `Forcefield: decoy ${first.kind} touched${input.site ? ` on ${input.site}` : ""}`,
      body:
        `${who} touched ${input.hits.length} decoy(s) (${kinds}) via ${input.action.kind}. ` +
        `Seeded in: ${Array.from(new Set(input.hits.map((h) => h.seededIn))).join("; ")}. ` +
        (input.agentId ? "The agent was quarantined and its scope revoked." : "Nothing legitimate reaches a decoy; treat the client as hostile."),
      site: input.site,
      attackClass: `canary_${first.kind}`,
      windowStart,
      metadata: { hits: input.hits.length, action_kind: input.action.kind },
    });
  } catch {
    out.alert = null;
  }
  return out;
}

/**
 * Inspect an INBOUND request (a connected site's request, or a message to the
 * agent API) against the workspace's decoys, and record + alert on a trip.
 * Uses the cached decoy list so it is safe on a hot path. Never throws; returns
 * the verdict so a caller can also act on it.
 */
export async function checkInboundForCanaries(
  input: { workspaceId: string; clientLabel: string; url?: string; headers?: string; payload?: string; site?: string; agentId?: string },
  deps: { load?: (ws: string) => Promise<readonly Canary[]>; record?: (t: CanaryTripInput) => Promise<CanaryTripOutcome> } = {},
): Promise<TripwireVerdict> {
  try {
    const canaries = await (deps.load ?? ((ws: string) => listCanariesForMatchingCached(ws)))(input.workspaceId);
    if (canaries.length === 0) return { tripped: false, hits: [], severity: "none" };
    const action: AgentAction = {
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? input.clientLabel,
      kind: "inbound_request",
      url: input.url,
      headers: input.headers,
      payload: input.payload,
    };
    const verdict = inspectAgentAction(action, canaries);
    if (verdict.tripped) {
      await (deps.record ?? ((t: CanaryTripInput) => recordCanaryTrip(t)))({
        workspaceId: input.workspaceId,
        action,
        hits: verdict.hits,
        agentId: input.agentId,
        site: input.site,
      }).catch(() => undefined);
    }
    return verdict;
  } catch {
    return { tripped: false, hits: [], severity: "none" };
  }
}
