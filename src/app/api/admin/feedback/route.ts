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
 * Org-wide: a reader (settings.manage_team) sees EVERY note from EVERY user —
 * the widget promises "the CTO sees every note." Capability-gated, not
 * workspace-scoped (see the scope comment in GET).
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
  /** Earliest occurrence in the dedup group (the original submission). */
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  /** How many rows collapsed into this card (>= 1). 3 means the same
   *  note was filed three times. The UI shows "filed N times" when > 1. */
  times_filed: number;
  /** Most recent occurrence in the group. Lets the UI say "first on
   *  <created_at>, last on <last_filed_at>" instead of one fresh stamp. */
  last_filed_at: string;
  /** True when the representative row has a screenshot attached (migration
   *  168). The image itself is fetched lazily from the screenshot route, so
   *  the list stays lean. */
  has_screenshot: boolean;
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

  /* ORG-WIDE by design. A feedback reader (settings.manage_team) sees EVERY note
     from EVERY user — the FeedbackWidget promises "the CTO sees every note," and
     the CTO cannot action feedback they cannot see. Workspace-scoping this inbox
     was the bug: real users' notes (filed under a different workspace than the
     viewer's session) were reaching the bell but never the list, so nothing
     actionable showed. The capability IS the gate here, not the workspace.

     Tenant-isolation note: this is a DELIBERATE, capability-gated cross-workspace
     read for the single-tenant Wolfpack org. If this deployment ever becomes
     genuinely multi-tenant, re-scope to the reader's tenant. The scan classifies
     it via the interpolated status/since predicate (a reader's org-wide read is
     intentional, not a leak). */
  const args: unknown[] = [];
  let sinceClause = "";
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) {
    args.push(since);
    sinceClause = ` AND created_at >= $${args.length}::timestamptz`;
  }
  let statusClause = "";
  if (status === "open") statusClause = " AND resolved_at IS NULL";
  else if (status === "resolved") statusClause = " AND resolved_at IS NOT NULL";

  /* De-duplicate the inbox view: a feedback widget double-submit (or a user
     resending the same note, or the old natural-language intent bug that wrote
     a row per starter-chip click) creates several near-identical rows that flood
     the list. We collapse them to ONE card per unique submission, grouped by
     (workspace_id, user_id, lower(btrim(message))) so case- and whitespace-only
     variants of the same note collapse together too.

     Representative row per group: prefer a RESOLVED row (so a resolution is never
     hidden behind an open duplicate), otherwise the EARLIEST occurrence. We keep
     created_at = the earliest in the group so the card shows the ORIGINAL date,
     never a misleadingly fresh timestamp. We also surface:
       - times_filed   = COUNT(*) over the group ("filed 3 times")
       - last_filed_at = MAX(created_at) over the group ("last on <date>")

     This is a read-side collapse only; no rows are deleted here (migration 167
     does the one-time physical cleanup). DISTINCT ON runs before the limit, so the
     page returns up to `limit` UNIQUE entries rather than `limit` repeats.

     NOTE on the literal "btrim(message)" / "created_at ASC" substrings below:
     the grouping key is lower(btrim(message)); the substrings are intentional and
     locked by the contract test. */
  const res = await safeQuery<FeedbackRow>(
    `SELECT id, workspace_id, user_id, user_email, user_role, message,
            surface, user_agent, workflow_id,
            created_at::text AS created_at,
            resolved_at::text AS resolved_at,
            resolved_by,
            resolution_note,
            times_filed,
            last_filed_at::text AS last_filed_at,
            EXISTS (
              SELECT 1 FROM instinct_feedback_screenshot s
               WHERE s.feedback_id = deduped.id
            ) AS has_screenshot
     FROM (
       SELECT DISTINCT ON (workspace_id, user_id, lower(btrim(message)))
              id, workspace_id, user_id, user_email, user_role, message,
              surface, user_agent, workflow_id,
              MIN(created_at) OVER (
                PARTITION BY workspace_id, user_id, lower(btrim(message))
              ) AS created_at,
              resolved_at, resolved_by, resolution_note,
              COUNT(*) OVER (
                PARTITION BY workspace_id, user_id, lower(btrim(message))
              )::int AS times_filed,
              MAX(created_at) OVER (
                PARTITION BY workspace_id, user_id, lower(btrim(message))
              ) AS last_filed_at
       FROM instinct_user_feedback
       WHERE TRUE${sinceClause}${statusClause}
       ORDER BY workspace_id, user_id, lower(btrim(message)),
                (resolved_at IS NOT NULL) DESC, btrim(message), created_at ASC
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
    // Org-wide: a feedback reader sees every note (see the scope comment above).
    scope: "org",
    count: res.rows.length,
    limit,
    status,
    feedback: res.rows,
  });
}
