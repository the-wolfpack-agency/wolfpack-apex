/**
 * GET /api/admin/feedback — CTO/CEO view of recent /feedback submissions.
 *
 * Shipped 2026-05-20 because the FeedbackWidget tells users "The CTO
 * sees every note" but no UI for the CTO to actually read them existed.
 * This makes that promise true.
 *
 * Query params:
 *   limit  — 1..200, default 50 (most recent first)
 *   since  — ISO timestamp; only feedback created after this time
 *
 * Capability: settings.manage_team (same gate as /api/team/invite —
 * the people who can invite teammates are the people who should read
 * teammate feedback).
 *
 * Workspace-scoped: only feedback from the caller's workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";

interface FeedbackRow {
  id: string;
  workspace_id: string;
  user_id: string;
  user_email: string | null;
  user_role: string | null;
  message: string;
  surface: string | null;
  user_agent: string | null;
  workflow_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
  const since = url.searchParams.get("since");
  /* status filter: "open" (default) | "resolved" | "all". Lets the
     dashboard render an inbox-style view without re-fetching every
     entry. */
  const status = (url.searchParams.get("status") || "all").toLowerCase();

  const workspaceId = auth.user.workspaceId ?? "default";
  const args: unknown[] = [workspaceId];
  let sinceClause = "";
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) {
    args.push(since);
    sinceClause = ` AND created_at >= $${args.length}::timestamptz`;
  }
  let statusClause = "";
  if (status === "open") statusClause = " AND resolved_at IS NULL";
  else if (status === "resolved") statusClause = " AND resolved_at IS NOT NULL";

  /* De-duplicate the inbox view: a feedback widget double-submit (or a user
     resending the same note) creates several identical rows that flood the list.
     We collapse them to one row per unique submission (same workspace, same
     user, same trimmed message), keeping the EARLIEST occurrence so the original
     timestamp and any resolution on it are preserved. This is a read-side
     collapse only; no rows are deleted. The DISTINCT ON runs before the limit, so
     the page returns up to `limit` UNIQUE entries rather than `limit` rows that
     turn out to be repeats. */
  const res = await safeQuery<FeedbackRow>(
    `SELECT id, workspace_id, user_id, user_email, user_role, message,
            surface, user_agent, workflow_id,
            created_at::text AS created_at,
            resolved_at::text AS resolved_at,
            resolved_by,
            resolution_note
     FROM (
       SELECT DISTINCT ON (workspace_id, user_id, btrim(message))
              id, workspace_id, user_id, user_email, user_role, message,
              surface, user_agent, workflow_id, created_at,
              resolved_at, resolved_by, resolution_note
       FROM instinct_user_feedback
       WHERE workspace_id = $1${sinceClause}${statusClause}
       ORDER BY workspace_id, user_id, btrim(message), created_at ASC
     ) deduped
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    args,
  );

  if (res.fromCache && process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database temporarily unavailable." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    workspace_id: workspaceId,
    count: res.rows.length,
    limit,
    status,
    feedback: res.rows,
  });
}
