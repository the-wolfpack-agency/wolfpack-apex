/**
 * GET /api/people/roster
 *
 * Everyone in the workspace: employee records, accounts, and outstanding
 * invites, merged into one list with an explicit access state per person.
 *
 * This is what /hr shows. The Employees tab used to list `apex_employees`
 * alone, so an invited teammate got access and never appeared anywhere in the
 * UI. See src/lib/people/roster.ts for the merge rules.
 *
 * Requires `hr.employees.view`, the same capability that governs the employee
 * list it replaces. It reports whether the caller may also change access
 * (`settings.manage_team`, held by CTO and CEO, not HR) so the UI can show the
 * controls only to somebody who can actually use them. The write endpoint
 * enforces that capability itself; `can_manage_access` is a hint for rendering,
 * never the gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listTeamMembers, listPendingInvites, pendingInvitesFor } from "@/lib/team/directory";
import { listEmployees } from "@/lib/people";
import { mergeRoster, summarizeRoster } from "@/lib/people/roster";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "hr.employees.view");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId;
  const [employees, memberRead, inviteRead] = await Promise.all([
    listEmployees(),
    listTeamMembers(workspaceId),
    listPendingInvites(workspaceId),
  ]);

  /* Say so rather than rendering a confident, wrong roster. A page that shows
     "nobody has access" because the database was briefly unreachable is worse
     than one that shows an error: somebody would act on it. */
  if (memberRead.degraded || inviteRead.degraded) {
    return NextResponse.json({ error: "Database temporarily unavailable." }, { status: 503 });
  }

  const roster = mergeRoster({
    employees,
    members: memberRead.rows,
    invites: pendingInvitesFor(inviteRead.rows, memberRead.rows),
  });

  trackEvent("hr.roster_viewed", auth.user.id, auth.user.role, summarizeRoster(roster));

  return NextResponse.json({
    roster,
    summary: summarizeRoster(roster),
    can_manage_access: auth.capabilities.has("settings.manage_team"),
  });
}
