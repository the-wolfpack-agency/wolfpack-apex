/**
 * POST /api/admin/platform-scans/ingest: ingest browser-journey findings.
 *
 * The browser layer of the platform-scan feature (a Playwright runner in CI)
 * loads a target platform's pages authenticated, classifies the live signals
 * into ScanFindings, and POSTs them here. This route is the seam between that
 * out-of-process runner and the shared findings store — the SAME store the
 * HTTP route probe writes to, so browser findings land in the same review UI.
 *
 * Two auth paths (mirrors /api/cron/integration-health):
 *   1. CI path: Authorization: Bearer ${CRON_SECRET}. The workflow hits this
 *      with the ingest secret. Returns false when CRON_SECRET is unset.
 *   2. User path: requireCapability(req, "settings.manage_team") for an admin
 *      ingesting a scan manually.
 *
 * Never 500s on a recoverable condition: a malformed body is a 400, a bad
 * payload that slips past validation returns a zeroed 200 so the CI runner's
 * post step stays green and the run is not lost to a transient store hiccup.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { recordScan } from "@/lib/platform-scan/store";
import { classifyPage, type PageObservation } from "@/lib/platform-scan/browser/classify";
import { classifyJourney, type JourneyTrace } from "@/lib/platform-scan/browser/journey";
import type { PlatformScanResult, ScanFinding } from "@/lib/platform-scan/types";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";

/**
 * ABUSE HARDENING (added when external runners/agents began POSTing here).
 *
 * Now that out-of-process runners and bring-your-own agents can hit this seam,
 * an unthrottled or oversized POST is a DoS + cost vector: each item drives
 * server-side classify work, then recordScan fans every finding out through the
 * triple-write + Brain + audit path. We cap two independent axes, fail CLOSED,
 * and keep legitimate scans byte-identical (see "WHY THESE LIMITS").
 */

/**
 * Per-array cap. No single source array (findings/observations/traces) may
 * exceed this. Catches the "one giant array" abuse shape that a total-only cap
 * would let a single field reach.
 */
const MAX_INGEST_ITEMS_PER_ARRAY = 1000;
/**
 * Total cap across findings[] + observations[] + traces[]. Catches the
 * "spread the load across all three arrays" shape that a per-array-only cap
 * would miss.
 */
const MAX_INGEST_ITEMS_TOTAL = 1000;
/**
 * Per-item size guard. A single absurdly large item (megabytes of nested junk)
 * is cheap to reject by serialized length and stops a low-count / high-bytes
 * payload from slipping past the count caps and blowing up classify/recordScan.
 * 64 KB per item is generous: a real ScanFinding / PageObservation / JourneyTrace
 * is well under 10 KB even with full evidence + step traces.
 */
const MAX_INGEST_ITEM_BYTES = 64 * 1024;

/**
 * WHY THESE LIMITS (compared + justified):
 *
 *  - A real browser scan covers tens to low-hundreds of routes/journeys; a
 *    findings[]-only post mirrors that count. 1000 items is several times the
 *    largest legitimate scan we have observed, so a normal scan is NEVER
 *    affected by the caps. Generous on purpose: fail-closed must not break the
 *    honest CI runner.
 *  - Rate limit: the shared DB fixed-window limiter (gate-rate-limit.ts) defaults
 *    to 120 requests / 60s per key. A CI scan posts ONCE per run (occasionally a
 *    handful for retries), so 120/min per workspace is far above legitimate use
 *    while still capping a runaway loop / cost-bomb caller. We deliberately
 *    REUSE that limiter (one limiter, one store, no duplicate counter) keyed by
 *    workspace so a noisy workspace cannot starve others.
 *  - We considered a byte-cap on the whole body instead of per-item; per-item is
 *    strictly cheaper (short-circuits on the first oversized item) and composes
 *    with the count caps. Next.js already bounds the raw body, so per-item is the
 *    meaningful additional guard at the application layer.
 */

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/** True if any element of `arr` serializes to more than MAX_INGEST_ITEM_BYTES. */
function hasOversizedItem(arr: unknown[] | null): boolean {
  if (!arr) return false;
  for (const item of arr) {
    let bytes: number;
    try {
      bytes = JSON.stringify(item)?.length ?? 0;
    } catch {
      // Unserializable (circular) -> treat as oversized/abusive, reject.
      return true;
    }
    if (bytes > MAX_INGEST_ITEM_BYTES) return true;
  }
  return false;
}

interface IngestBody {
  platform?: unknown;
  baseUrl?: unknown;
  routeCount?: unknown;
  findings?: unknown;
  /**
   * Optional RAW page observations. When present, apex classifies them
   * SERVER-SIDE via classifyPage so the UX detectors live and improve centrally
   * here and the external browser-scan runner can stay dumb (it ships raw signals
   * rather than pre-classified findings). The classified findings flow through the
   * SAME recordScan path as directly-supplied findings[] - no data lost.
   */
  observations?: unknown;
  /**
   * Optional tier-2 JOURNEY TRACES. Each trace is one full agent attempt at a
   * goal (the ordered gated actions). When present, apex runs classifyJourney
   * SERVER-SIDE (pure) and the friction findings flow through the SAME recordScan
   * path as findings[]/observations[]. Additive: absent, behavior is unchanged.
   * This is the ingest side of the openclaw driver contract (see browser/journey.ts).
   */
  traces?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds.
  let workspaceId = "default";
  let actorId = "browser-scan";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // CI path: anonymous agent into the default workspace.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    workspaceId = auth.user.workspaceId ?? "default";
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  // Either source may drive the scan; at least one must be present.
  const directFindings = Array.isArray(body.findings)
    ? (body.findings as ScanFinding[])
    : null;
  const observations = Array.isArray(body.observations)
    ? (body.observations as PageObservation[])
    : null;
  const traces = Array.isArray(body.traces)
    ? (body.traces as JourneyTrace[])
    : null;
  if (!platform || !baseUrl || (!directFindings && !observations && !traces)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "platform, baseUrl and at least one of findings[], observations[] or traces[] are required",
      },
      { status: 400 },
    );
  }

  // --- ABUSE GUARDS (ordering: auth -> rate limit -> payload caps -> work) ---
  // Auth + workspace resolution already happened above. We rate-limit BEFORE the
  // (potentially large) payload-cap scan and BEFORE the expensive classify /
  // recordScan work, so a caller in a tight loop is throttled cheaply. Both
  // guards reject before any server-side classification runs, so no abusive
  // payload reaches the cost-bearing path. Legitimate scans pass both untouched.

  // RATE LIMIT: per-workspace fixed-window budget via the SHARED limiter (reused,
  // not duplicated). Keyed by workspace so one noisy tenant cannot starve others.
  // Fails closed: on a DB error the limiter returns { ok: false } and we 429.
  const rl = await checkRateLimit(`ingest:${workspaceId}`);
  if (!rl.ok) {
    trackEvent("platform.scan_ingest_rejected", actorId, actorRole, {
      reason: "rate_limited",
      workspace_id: workspaceId,
    });
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // PAYLOAD CAPS: reject oversized payloads with 413 before any classify work.
  const findingsLen = directFindings?.length ?? 0;
  const observationsLen = observations?.length ?? 0;
  const tracesLen = traces?.length ?? 0;
  const totalItems = findingsLen + observationsLen + tracesLen;
  const tooManyItems =
    totalItems > MAX_INGEST_ITEMS_TOTAL ||
    findingsLen > MAX_INGEST_ITEMS_PER_ARRAY ||
    observationsLen > MAX_INGEST_ITEMS_PER_ARRAY ||
    tracesLen > MAX_INGEST_ITEMS_PER_ARRAY;
  const tooLargeItem =
    hasOversizedItem(directFindings) ||
    hasOversizedItem(observations) ||
    hasOversizedItem(traces);
  if (tooManyItems || tooLargeItem) {
    trackEvent("platform.scan_ingest_rejected", actorId, actorRole, {
      reason: "payload_too_large",
      workspace_id: workspaceId,
    });
    return NextResponse.json(
      { ok: false, error: "payload_too_large" },
      { status: 413 },
    );
  }

  // Classify any raw observations and journey traces SERVER-SIDE (classifyPage
  // and classifyJourney are pure), then merge with directly-supplied findings.
  // All sources feed the SAME scan so they flow through the identical recordScan
  // path (dedup, auto-resolve, Brain, analytics) - no data lost.
  const classifiedFindings = (observations ?? []).flatMap((obs) => classifyPage(obs));
  const journeyFindings = (traces ?? []).flatMap((trace) => classifyJourney(trace));
  const typedFindings: ScanFinding[] = [
    ...(directFindings ?? []),
    ...classifiedFindings,
    ...journeyFindings,
  ];

  // routeCount defaults to the count of probed units when observations and/or
  // traces drive the request (each is one route/journey the runner covered);
  // otherwise it falls back to the merged finding count (today's behavior for a
  // findings[]-only request). Explicit body.routeCount always wins.
  const probedUnits = (observations?.length ?? 0) + (traces?.length ?? 0);
  const routeCount =
    typeof body.routeCount === "number"
      ? body.routeCount
      : probedUnits > 0
        ? probedUnits
        : typedFindings.length;

  const result: PlatformScanResult = {
    platform,
    baseUrl,
    routeCount,
    okCount: 0,
    findings: typedFindings,
  };

  try {
    const { scanId, findingCount } = await recordScan({
      workspaceId,
      actorId,
      actorRole,
      result,
    });
    // Audit the ingest (hash-chained, immutable): a browser-runner scan landing
    // findings is a security-relevant agent action. Best effort.
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: actorId, role: actorRole },
      action: "platform.scan_ingested",
      resourceType: "platform_scan",
      resourceId: scanId ?? "unknown",
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
      afterState: { platform, finding_count: findingCount, source: "browser" },
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ ok: true, scanId, findingCount });
  } catch (err) {
    // DATA-LOSS FIX: a recordScan throw used to return { ok:true, scanId:null,
    // findingCount:0 } - the false-success that made a CI runner mark the run GREEN
    // and DISCARD the only copy of the findings it just collected. A persistence
    // failure (a real write error, a 0-row RLS-discarded write surfaced by
    // expectRows, or shadow-mode `no_database`) is NOT a success: return a non-2xx
    // so the caller RETRIES instead of dropping data, and fire
    // platform.scan_persist_degraded so the learning loop records the dropped run
    // and never mistakes a failed persist for a clean ingest.
    const e = err as Error;
    const wqe = err instanceof WriteQueryError ? err : null;
    // no_database (shadow mode) is a misconfiguration, not a transient blip ->
    // 503 (no point hammering retries, but explicitly NOT ok). A real write/row
    // error is potentially transient -> 500 so the runner retries.
    const status = wqe?.code === "no_database" ? 503 : 500;
    const detail = wqe ? `${wqe.code}: ${wqe.message}` : e.message;
    console.error("[platform-scans/ingest] persist failed:", detail);
    trackEvent("platform.scan_persist_degraded", actorId, actorRole, {
      surface: "ingest",
      detail,
      platform,
      finding_count: typedFindings.length,
      workspace_id: workspaceId,
    });
    return NextResponse.json(
      { ok: false, error: "persist_failed", reason: wqe?.code ?? "db_error" },
      { status },
    );
  }
}
