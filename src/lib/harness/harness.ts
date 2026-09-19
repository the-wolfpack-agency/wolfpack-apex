/**
 * Public agent harness - session lifecycle + hit capture + reading, over
 * Postgres. This is the DB layer; the sandbox content (sandbox.ts) and the
 * reading math (reading.ts) are pure and tested without a database.
 *
 * PUBLIC and unauthenticated by design, so it is deliberately hardened:
 *   - session ids are unguessable (crypto random), so only the developer who
 *     started a session can drive it,
 *   - a short TTL and a hard per-session hit cap bound what an anonymous caller
 *     can store,
 *   - NO PII is written (no IP, no raw UA, no bodies) - only relative path,
 *     method, status, and the structural event a hit maps to.
 *
 * Learning integration (the directive: no data lost). The FIRST time a session
 * with hits is read, its reading is captured as ONE sighting into the operators
 * intelligence under a reserved, non-tenant workspace, so harness runs feed the
 * same operator-attribution store as live traffic without ever touching a real
 * tenant's board. Capture is idempotent via the sighting_recorded flag.
 */

import { randomBytes } from "crypto";
import { query } from "@/lib/db";
import { recordSighting } from "@/lib/agent-operators";
import { buildHarnessReading, type HarnessHit, type HarnessReading } from "@/lib/harness/reading";
import { renderSandbox, sandboxEventFor, type SandboxResponse } from "@/lib/harness/sandbox";

/** Session TTL and the hard per-session hit cap. Short + bounded because this is
 *  an anonymous public surface. */
export const HARNESS_TTL_MINUTES = 30;
export const HARNESS_MAX_HITS = 300;
/** Reserved workspace so harness sightings feed learning without polluting any
 *  real tenant's operators board. */
export const HARNESS_WORKSPACE = "public-harness";

export interface HarnessSession {
  id: string;
  goal: string;
  agentLabel: string;
  expiresAt: string;
}

function newSessionId(): string {
  return `hs_${randomBytes(18).toString("base64url")}`;
}

/** Create a session. Returns the token + expiry; the caller builds the sandbox
 *  URL from the token. */
export async function createHarnessSession(input: { goal?: string; agentLabel?: string }): Promise<HarnessSession> {
  const id = newSessionId();
  const goal = (input.goal ?? "Explore the site and find anything interesting.").slice(0, 500);
  const agentLabel = (input.agentLabel ?? "unlabeled agent").slice(0, 120);
  const { rows } = await query<{ expires_at: string }>(
    `INSERT INTO instinct_harness_sessions (id, goal, agent_label, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
     RETURNING expires_at`,
    [id, goal, agentLabel, String(HARNESS_TTL_MINUTES)],
  );
  return { id, goal, agentLabel, expiresAt: rows[0]?.expires_at ?? "" };
}

type SessionRow = {
  id: string;
  goal: string | null;
  agent_label: string | null;
  hit_count: number;
  sighting_recorded: boolean;
  expired: boolean;
};

async function loadSession(id: string): Promise<SessionRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT id, goal, agent_label, hit_count, sighting_recorded, (expires_at < now()) AS expired
       FROM instinct_harness_sessions WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export type RecordHitResult =
  | { ok: true; response: SandboxResponse }
  | { ok: false; reason: "unknown" | "expired" | "capped"; response: SandboxResponse };

/**
 * Serve one sandbox request for a session and record the hit. `relPath` is the
 * path relative to the sandbox base ("/", "/pricing", "/_ff/records"). `base` is
 * the absolute sandbox base for link rendering. Honeypot: a POST that filled the
 * hidden field is recorded as a form-honeypot event.
 */
export async function recordHarnessHit(input: {
  sessionId: string;
  relPath: string;
  method: string;
  base: string;
  honeypotTripped?: boolean;
}): Promise<RecordHitResult> {
  const { sessionId, relPath, method, base, honeypotTripped } = input;
  const session = await loadSession(sessionId);
  const rendered = renderSandbox(relPath, base);
  if (!session) return { ok: false, reason: "unknown", response: { status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title><h1>404</h1>" } };
  if (session.expired) return { ok: false, reason: "expired", response: { status: 410, contentType: "text/plain", body: "harness session expired" } };
  if (session.hit_count >= HARNESS_MAX_HITS) return { ok: false, reason: "capped", response: { status: 429, contentType: "text/plain", body: "harness session hit cap reached" } };

  const eventType = honeypotTripped && method.toUpperCase() === "POST" ? "site.agent_form_honeypot" : sandboxEventFor(relPath);
  await query(
    `INSERT INTO instinct_harness_hits (session_id, path, method, status, event_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, relPath, method.toUpperCase(), rendered.status, eventType],
  );
  await query(`UPDATE instinct_harness_sessions SET hit_count = hit_count + 1 WHERE id = $1`, [sessionId]);
  return { ok: true, response: rendered };
}

async function loadHits(sessionId: string): Promise<HarnessHit[]> {
  const { rows } = await query<{ path: string; method: string; status: number; event_type: string | null; seen_at: string }>(
    `SELECT path, method, status, event_type, seen_at
       FROM instinct_harness_hits WHERE session_id = $1 ORDER BY seen_at ASC`,
    [sessionId],
  );
  return rows.map((r) => ({ path: r.path, method: r.method, status: r.status, eventType: r.event_type, at: r.seen_at }));
}

export type ReadingResult =
  | { ok: true; reading: HarnessReading; expired: boolean }
  | { ok: false; reason: "unknown" | "unavailable" };

/**
 * Compute the reading for a session. On the first read of a session that has
 * hits, capture ONE sighting into the operators intelligence (idempotent via
 * sighting_recorded), so the run is not lost to learning.
 */
export async function getHarnessReading(sessionId: string, surface: string): Promise<ReadingResult> {
  // The reading is polled repeatedly and shares the app's Postgres pool with the
  // write-heavy sandbox. A transient connection hiccup on either read must
  // degrade to a retryable "unavailable", never an unhandled 500 - the client
  // just polls again. (recordSighting below is already best-effort.)
  let session: SessionRow | null;
  let hits: HarnessHit[];
  try {
    session = await loadSession(sessionId);
    if (!session) return { ok: false, reason: "unknown" };
    hits = await loadHits(sessionId);
  } catch (err) {
    console.warn("[harness] reading read failed (transient):", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }
  const reading = buildHarnessReading({
    sessionId,
    agentLabel: session.agent_label ?? "unlabeled agent",
    goal: session.goal ?? "",
    surface,
    hits,
  });

  if (hits.length > 0 && !session.sighting_recorded) {
    try {
      const operatorKey = await recordSighting({ workspaceId: HARNESS_WORKSPACE, sighting: reading.sighting });
      await query(
        `UPDATE instinct_harness_sessions SET sighting_recorded = true, operator_key = $2 WHERE id = $1`,
        [sessionId, operatorKey],
      );
    } catch {
      /* learning capture is best-effort; never fail the reading */
    }
  }

  return { ok: true, reading, expired: session.expired };
}
