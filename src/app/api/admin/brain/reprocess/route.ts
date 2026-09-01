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
import { findRepairIdentity, NO_IDENTITY_MESSAGE } from "@/lib/brain/repair-identity";
import { downloadDriveItem } from "@/lib/connectors/sharepoint/sync";
import { query } from "@/lib/db";
import { recordAudit } from "@/lib/audit-log";

/**
 * Cron secret check. Mirrors src/app/api/cron/agent-failover/route.ts so every
 * cron-triggered endpoint in this repo shares one mental model. Returns false
 * when CRON_SECRET is unset (local dev) so the session path is the only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * TWO WAYS IN, AND THE SECOND ONE IS THE POINT.
 *
 * This repair was written for ninety Word documents that failed on a parser
 * bug fixed in #402. Measured 2026-08-27: it had never run. Not once. Zero
 * events, and the ninety documents were still failed, months after the fix
 * that was supposed to rescue them shipped.
 *
 * A repair that needs somebody to remember it is a repair that does not
 * happen, which is the same shape as a control declared and never executed.
 * So it now runs on a schedule as well as by hand.
 */
async function gate(req: NextRequest) {
  if (isAuthorizedCron(req)) {
    /* The scheduled path has no session. It acts as the system, and the audit
       row says so rather than attributing the repair to whoever last logged
       in. */
    return { user: { id: "cron", role: "system", workspaceId: "default" } as const };
  }
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

  /* WHOSE ACCESS THE DOWNLOAD USES, AND ONLY WHEN THERE IS NOBODY.
   *
   * A signed-in caller repairs on their OWN token. That is a property worth
   * keeping and a test protects it: an admin pressing repair must not quietly
   * reach files through somebody else's access, whatever the job is doing.
   *
   * The scheduled path is the exception, because user.id is "cron", which is
   * right for the audit row and useless for Graph. "cron" has never completed
   * an OAuth flow, so getValidToken returns null and every document fails with
   * no_token. That was true of every scheduled run this job has ever made, and
   * reconnecting Microsoft would not have changed it.
   *
   * So only the cron borrows, and only from an account that already connected.
   * It grants no new access: a delegated token reads exactly the drives that
   * person can read, which is the boundary the original ingest ran under. */
  const borrowing = user.id === "cron";
  const identity = borrowing ? await findRepairIdentity() : null;
  if (borrowing && !identity) {
    return NextResponse.json(
      { ok: false, considered: 0, repaired: 0, stillFailing: 0, error: NO_IDENTITY_MESSAGE },
      { status: 200, headers: NO_STORE },
    );
  }
  const downloadAs = identity?.userEmail ?? user.id;

  try {
    const report = await reprocessFixable(
      async (driveItemId) => {
        if (!anyDrive) return null;
        return downloadDriveItem(downloadAs, anyDrive, driveItemId);
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
        /* Named, because a repair that rewrites a document library under a
           borrowed identity should record whose access it used. Equal to the
           actor on an interactive run, which is the point. */
        ran_as: downloadAs,
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
