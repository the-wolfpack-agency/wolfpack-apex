import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { offboardWorkspace } from "@/lib/platform-scan/offboarding";

/**
 * POST /api/admin/platform-scans/offboard
 *
 * DESTRUCTIVE: purge ALL platform-scan data for a workspace across Postgres +
 * Qdrant + Neo4j (findings, scans + coverage, targets, ownership verifications,
 * system profiles, automation recommendations, pentest authorizations, and
 * connector credentials). Irreversible.
 *
 * Because it is irreversible, the route is guarded TWICE:
 *   1. HIGH CAPABILITY  - requireCapability("settings.manage_team"), the same
 *      admin gate the rest of the platform-scan admin surface uses.
 *   2. EXPLICIT TYPED CONFIRMATION - body.confirm MUST equal body.workspaceId.
 *      A mismatch (or missing confirm) is a 400 and NO purge runs. This is the
 *      "type the resource name to delete it" pattern: it makes an accidental or
 *      mistargeted erasure impossible without the operator naming the exact
 *      workspace they intend to wipe.
 *
 * Every call - allowed or refused - is auditable. The purge itself writes the
 * hash-chained audit entry, the offboarding_log ledger row, and the analytics
 * event from offboardWorkspace; this route additionally audits a REFUSED attempt
 * so a wrong-confirm probe is on the record too.
 *
 * Body: { workspaceId: string, confirm: string }
 * Returns: { ok, workspaceId, counts, residue, totalDeleted, secondaryStoresClean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: { workspaceId?: unknown; confirm?: unknown };
  try {
    body = (await req.json()) as { workspaceId?: unknown; confirm?: unknown };
  } catch {
    body = {};
  }

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";

  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id_required" }, { status: 400 });
  }

  // The destructive confirmation gate. The operator must echo back the EXACT
  // workspace id. Anything else refuses with a 400 and runs NO purge.
  if (confirm !== workspaceId) {
    const meta = extractRequestMetadata(req);
    // A refused (mistargeted / unconfirmed) purge is itself a security-relevant
    // event worth a permanent record. Audited via the hash-chained log; no
    // analytics event is fired here because none is registered for a refusal and
    // analytics.ts is out of scope to edit.
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "platform.workspace_offboard_refused",
      resourceType: "workspace",
      resourceId: workspaceId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      afterState: { reason: "confirmation_mismatch" },
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json(
      {
        error: "confirmation_required",
        detail: "The confirmation must exactly match the workspace id. No data was purged.",
      },
      { status: 400 },
    );
  }

  // Confirmation matched: perform the irreversible purge. offboardWorkspace writes
  // the audit entry + offboarding_log + analytics event itself.
  const result = await offboardWorkspace(workspaceId, { user_id: user.id, role: user.role });

  return NextResponse.json({
    ok: true,
    workspaceId: result.workspaceId,
    counts: result.counts,
    residue: result.residue,
    totalDeleted: result.totalDeleted,
    secondaryStoresClean: result.secondaryStoresClean,
  });
}
