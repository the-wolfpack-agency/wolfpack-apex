import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { bulkTriageFindings } from "@/lib/platform-scan/store";
import type { ScanSeverity } from "@/lib/platform-scan/types";

const TRIAGE_STATUSES = ["acknowledged", "resolved"] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

const VALID_SEVERITIES: ScanSeverity[] = ["critical", "high", "medium", "low"];

/** Validate a severity subset; undefined when absent/empty (= all severities).
 *  Accepts either a string[] or a `"critical,high"` csv. */
function parseSeverities(raw: unknown): ScanSeverity[] | undefined {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim())
      : [];
  const out = list.filter((s): s is ScanSeverity => (VALID_SEVERITIES as string[]).includes(s));
  return out.length > 0 ? out : undefined;
}

/**
 * POST /api/admin/platform-scans/findings/bulk  body: { status, severity?, platform? }
 *
 * Triages EVERY currently-open finding matching the active filter in one UPDATE
 * (the bulk counterpart to findings/[id]). `severity`/`platform` mirror the
 * findings list filter so the operator triages exactly what is on screen — the
 * ~73 low-severity smells stay untouched when the view is filtered to
 * critical+high. Gated on settings.manage_team, hash-chain audited. Returns the
 * number of findings moved.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  let body: { status?: string; severity?: unknown; platform?: string };
  try {
    body = (await req.json()) as { status?: string; severity?: unknown; platform?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const status = body.status;
  if (!TRIAGE_STATUSES.includes(status as TriageStatus)) {
    return NextResponse.json(
      { error: "status must be 'acknowledged' or 'resolved'" },
      { status: 400 },
    );
  }
  const severities = parseSeverities(body.severity);
  const platform = typeof body.platform === "string" && body.platform ? body.platform : undefined;

  const count = await bulkTriageFindings(
    workspaceId,
    { status: status as TriageStatus, severities, platform },
    user.id,
    user.role,
  );

  // Audit the bulk triage (hash-chained, immutable). Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.findings_bulk_triaged",
    resourceType: "platform_scan_finding",
    resourceId: workspaceId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { status, count, severities: severities ?? "all", platform: platform ?? "all" },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, count });
}
