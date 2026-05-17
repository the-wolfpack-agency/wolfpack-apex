/**
 * GET /api/health/integrations
 *
 * Per-workspace integration health probe surface. Two modes:
 *   - default (no params): just read the latest persisted health
 *     row per (vendor, probeKind, objectType) from the
 *     integration_health_latest view. Cheap; safe to poll from a
 *     dashboard.
 *   - ?run=true: actively probe each vendor + persist the result.
 *     Intended for the AgenticQA nightly orchestrator. Authenticated
 *     callers only (matches the rest of the assistant surface).
 *
 * Response envelope:
 *   {
 *     workspaceId,
 *     probedAt,        // when this read was served
 *     vendors: [{
 *       vendor,
 *       connectivity:  { ok, statusCode, errorMessage, probedAt }?,
 *       schema: [{ objectType, ok, schemaHash, drifted, probedAt }],
 *     }]
 *   }
 *
 * `drifted` is computed by comparing the latest schema_hash with the
 * previous one for the same (vendor, objectType). The nightly
 * orchestrator alerts on drifted=true.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import type { Capability } from "@/lib/auth/capabilities";
import {
  runProbe,
  persistProbeResult,
  type ProbeKind,
} from "@/lib/health/integration-probes";

const PROBE_CAPABILITY = "admin.health.probe" as Capability;

/* Default vendor x object set probed on ?run=true. AgenticQA's
 * orchestrator can pass ?vendors=...&objects=... to narrow if a
 * vendor's rate-limiting an aggregate sweep. */
const DEFAULT_VENDORS: Array<{ vendor: string; objects: string[]; needsUserId: boolean }> = [
  { vendor: "microsoft", objects: ["task", "event", "message"], needsUserId: true },
  { vendor: "salesforce", objects: ["deal", "contact", "account"], needsUserId: false },
  { vendor: "hubspot", objects: ["deal", "contact", "account"], needsUserId: false },
  { vendor: "quickbooks", objects: [], needsUserId: false },
];

interface LatestRow {
  vendor: string;
  probe_kind: string;
  object_type: string | null;
  ok: boolean;
  status_code: number | null;
  schema_hash: string | null;
  error_message: string | null;
  duration_ms: number;
  probed_at: string;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  /* Auth gate: principle of least privilege. Privileged roles
   * (CEO/CTO/EVP) always allowed for hands-on debugging. A
   * service-account user with the admin.health.probe capability is
   * the right principal for the AgenticQA nightly orchestrator —
   * grants probe access without exposing every CTO surface. */
  const isPrivileged =
    user.role === "ceo" || user.role === "cto" || user.role === "evp";
  if (!isPrivileged) {
    let hasCap = false;
    try {
      const { capabilities } = await effectiveCapabilitiesFor(user);
      hasCap = capabilities.has(PROBE_CAPABILITY);
    } catch {
      /* Capability stream may not be available — fall through to deny. */
    }
    if (!hasCap) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
  const url = new URL(req.url);
  const run = url.searchParams.get("run") === "true";

  if (run) {
    /* Active sweep — fan out probes, persist each result. The fan-out
     * is per-vendor sequential so a single vendor's failure doesn't
     * stall the others, but probes within a vendor run in parallel. */
    const sweepStarted = Date.now();
    for (const v of DEFAULT_VENDORS) {
      const ctx = { workspaceId, userId: v.needsUserId ? user.id : undefined };
      const connectivity = await runProbe(v.vendor, "connectivity", ctx);
      await persistProbeResult(workspaceId, connectivity);
      if (connectivity.ok && v.objects.length > 0) {
        const schemaResults = await Promise.all(
          v.objects.map((o) => runProbe(v.vendor, "schema", ctx, o)),
        );
        for (const sr of schemaResults) {
          await persistProbeResult(workspaceId, sr);
        }
      }
    }
    trackEvent("integration.health_sweep", user.id, user.role, {
      workspace_id: workspaceId,
      duration_ms: Date.now() - sweepStarted,
    });
  }

  /* Read latest persisted rows from the view. Works whether the
   * sweep just ran or whether a nightly job ran two hours ago. */
  let latestRows: LatestRow[] = [];
  if (process.env.DATABASE_URL) {
    try {
      const r = await safeQuery<LatestRow>(
        `SELECT vendor, probe_kind, object_type, ok, status_code,
                schema_hash, error_message, duration_ms,
                probed_at::text AS probed_at
           FROM integration_health_latest
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      latestRows = r.rows;
    } catch (err) {
      console.warn("[health/integrations] latest read failed:", (err as Error).message);
    }
  }

  /* Compute schema-drift flag per (vendor, objectType) by looking up
   * the second-most-recent OK schema hash and comparing. */
  const driftMap = await computeDriftMap(workspaceId, latestRows);

  /* Reshape into per-vendor envelope. Vendor order mirrors
   * DEFAULT_VENDORS so the response is stable. */
  const vendors = DEFAULT_VENDORS.map((v) => {
    const connectivity = latestRows.find(
      (r) => r.vendor === v.vendor && r.probe_kind === "connectivity",
    );
    const schema = latestRows
      .filter((r) => r.vendor === v.vendor && r.probe_kind === "schema")
      .map((r) => ({
        objectType: r.object_type,
        ok: r.ok,
        statusCode: r.status_code,
        schemaHash: r.schema_hash,
        drifted: driftMap.get(`${r.vendor}:${r.object_type ?? ""}`) ?? false,
        errorMessage: r.error_message,
        probedAt: r.probed_at,
      }));
    return {
      vendor: v.vendor,
      connectivity: connectivity
        ? {
            ok: connectivity.ok,
            statusCode: connectivity.status_code,
            errorMessage: connectivity.error_message,
            probedAt: connectivity.probed_at,
          }
        : null,
      schema,
    };
  });

  return NextResponse.json({
    workspaceId,
    probedAt: new Date().toISOString(),
    sweepRan: run,
    vendors,
  });
}

async function computeDriftMap(
  workspaceId: string,
  latestRows: LatestRow[],
): Promise<Map<string, boolean>> {
  const drift = new Map<string, boolean>();
  if (!process.env.DATABASE_URL) return drift;
  const schemaRows = latestRows.filter(
    (r) => r.probe_kind === "schema" && r.ok && r.schema_hash,
  );
  for (const row of schemaRows) {
    try {
      /* Pull the prior OK schema hash for this (vendor, object). If
       * it exists and differs from the latest, that's drift. */
      const r = await safeQuery<{ schema_hash: string }>(
        `SELECT schema_hash
           FROM integration_health
          WHERE workspace_id = $1
            AND vendor = $2
            AND probe_kind = 'schema'
            AND COALESCE(object_type, '') = COALESCE($3, '')
            AND ok = true
            AND schema_hash IS NOT NULL
            AND schema_hash <> $4
          ORDER BY probed_at DESC
          LIMIT 1`,
        [workspaceId, row.vendor, row.object_type ?? "", row.schema_hash],
      );
      drift.set(`${row.vendor}:${row.object_type ?? ""}`, r.rows.length > 0);
    } catch {
      /* Drift detection failure is non-fatal — default false. */
    }
  }
  return drift;
}

/**
 * POST alias. The AgenticQA nightly orchestrator POSTs ?run=true
 * because the sweep is a side effect; POST is more correct than GET
 * for a write-shaped action. Same handler, no body required.
 */
export async function POST(req: NextRequest) {
  return GET(req);
}
