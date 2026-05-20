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
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
  const since = url.searchParams.get("since");

  const workspaceId = auth.user.workspaceId ?? "default";
  const args: unknown[] = [workspaceId];
  let sinceClause = "";
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) {
    args.push(since);
    sinceClause = ` AND created_at >= $${args.length}::timestamptz`;
  }

  const res = await safeQuery<FeedbackRow>(
    `SELECT id, workspace_id, user_id, user_email, user_role, message,
            surface, user_agent, workflow_id, created_at::text AS created_at
     FROM instinct_user_feedback
     WHERE workspace_id = $1${sinceClause}
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
    feedback: res.rows,
  });
}
