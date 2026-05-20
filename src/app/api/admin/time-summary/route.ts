/**
 * GET /api/admin/time-summary — CTO/CEO breakdown of team time entries.
 *
 * Workspace-scoped. Optional ?since= / ?until= (YYYY-MM-DD).
 * Default window: last 30 days.
 *
 * Returns:
 *   buckets:  rows of user × job_code with totals
 *   per_user: roll-up by user
 *   per_job:  roll-up by job_code
 *   summary:  total hours, entry count, contributor count, window
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { summarizeTimeEntries } from "@/lib/time-entries";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const since =
    url.searchParams.get("since") ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const until = url.searchParams.get("until") || undefined;

  const buckets = await summarizeTimeEntries({
    workspaceId: auth.user.workspaceId,
    since,
    until,
  });

  const perUserMap = new Map<string, { user_id: string; user_email: string | null; total_hours: number; entry_count: number }>();
  const perJobMap = new Map<string, { job_code: string; total_hours: number; entry_count: number; contributors: Set<string> }>();
  let total = 0;
  let entries = 0;
  for (const b of buckets) {
    total += b.total_hours;
    entries += b.entry_count;
    const u = perUserMap.get(b.user_id) ?? {
      user_id: b.user_id,
      user_email: b.user_email,
      total_hours: 0,
      entry_count: 0,
    };
    u.total_hours += b.total_hours;
    u.entry_count += b.entry_count;
    perUserMap.set(b.user_id, u);
    const j = perJobMap.get(b.job_code) ?? {
      job_code: b.job_code,
      total_hours: 0,
      entry_count: 0,
      contributors: new Set<string>(),
    };
    j.total_hours += b.total_hours;
    j.entry_count += b.entry_count;
    j.contributors.add(b.user_id);
    perJobMap.set(b.job_code, j);
  }

  const per_user = [...perUserMap.values()].sort((a, b) => b.total_hours - a.total_hours);
  const per_job = [...perJobMap.values()]
    .map((j) => ({
      job_code: j.job_code,
      total_hours: j.total_hours,
      entry_count: j.entry_count,
      contributor_count: j.contributors.size,
    }))
    .sort((a, b) => b.total_hours - a.total_hours);

  return NextResponse.json({
    summary: {
      total_hours: total,
      entry_count: entries,
      contributor_count: perUserMap.size,
      job_code_count: perJobMap.size,
      since,
      until: until ?? null,
    },
    buckets,
    per_user,
    per_job,
    fetched_at: new Date().toISOString(),
  });
}
