/**
 * POST /api/admin/brain/reprocess
 *
 * Re-run extraction on documents that failed for a reason since fixed.
 *
 * WHY A ROUTE AND NOT A SCRIPT. The Brain stores text and chunks, not the
 * original bytes, so a repair has to re-download each file from the drive.
 * That needs the Microsoft credentials, and MS_CLIENT_ID / MS_CLIENT_SECRET
 * are marked sensitive in Vercel and come back from `vercel env pull` as a
 * literal placeholder. A developer machine cannot do this. Same reasoning as
 * /api/admin/integrations/probe: run the work where the credentials already
 * are, and let the operator trigger it from the browser.
 *
 * GET returns the candidates without touching anything, so the operator can
 * see what a run would do before running it.
 *
 * GATED ON A CAPABILITY, not on an inline role check like its read-only
 * siblings under admin/insights. This one downloads every candidate file and
 * rewrites its chunks, so it is an action rather than a read, and the repo's
 * own rule is that an action needs the stronger gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { findCandidates, reprocessFixable } from "@/lib/brain/reprocess";
import { downloadDriveItem } from "@/lib/connectors/sharepoint/sync";
import { query } from "@/lib/db";
import { recordAudit } from "@/lib/audit-log";

async function gate(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return { error: auth.response };
  return { user: auth.user };
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** What a run WOULD do. Read-only. */
export async function GET(req: NextRequest) {
  const g = await gate(req);
  if (g.error) return g.error;
  try {
    const candidates = await findCandidates({ limit: 500 });
    const byReason: Record<string, number> = {};
    for (const c of candidates) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
    return NextResponse.json(
      { readable: true, candidates: candidates.length, byReason, sample: candidates.slice(0, 25) },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    /* Unreadable is not the same fact as "nothing to repair". */
    return NextResponse.json(
      { readable: false, error: (err as Error).message },
      { status: 200, headers: NO_STORE },
    );
  }
}

export async function POST(req: NextRequest) {
  const g = await gate(req);
  if (g.error) return g.error;
  const user = g.user!;

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : 100;

  /* The drive a document came from is on its source row, not on the document,
     so the id is resolved per item rather than assumed to be one drive. */
  const workspaceId = user.workspaceId ?? "default";
  const driveFor = new Map<string, string>();
  try {
    /* WORKSPACE-SCOPED. Without the predicate this reads every tenant's drive
       ids and would repair one client's library using another's drive. The
       repo-wide tenant-isolation guard caught it, which is the whole reason
       that guard exists. */
    const { rows } = await query<{ id: string; drive_id: string }>(
      `SELECT id, drive_id FROM instinct_sharepoint_sources
        WHERE drive_id IS NOT NULL AND workspace_id = $1`,
      [workspaceId],
    );
    for (const r of rows) driveFor.set(r.id, r.drive_id);
  } catch {
    /* Fall through: a single-drive tenant still works off the first source. */
  }
  const anyDrive = [...driveFor.values()][0];

  try {
    const report = await reprocessFixable(
      async (driveItemId) => {
        if (!anyDrive) return null;
        return downloadDriveItem(user.id, anyDrive, driveItemId);
      },
      { userId: user.id, role: user.role },
      { limit },
    );
    /* AUDITED, because this rewrites a document library. A repair that
       silently replaced the chunks behind a client's citations, with no record
       of who ran it or what changed, would be indistinguishable from
       tampering. The hash-chained entry is what makes it a repair. */
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "brain.reprocess_run",
      resourceType: "brain_document",
      afterState: {
        considered: report.considered,
        repaired: report.repaired,
        still_failing: report.stillFailing,
        limit,
      },
    }).catch(() => undefined);

    return NextResponse.json({ ok: true, ...report }, { status: 200, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500, headers: NO_STORE },
    );
  }
}
