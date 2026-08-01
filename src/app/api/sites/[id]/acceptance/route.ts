/**
 * /api/sites/[id]/acceptance — the contract a generated site is judged against,
 * and the record of every judgement.
 *
 *   GET → 200 { criteria, completeness, runs } | 401 | 404
 *   PUT → 200 { criteria, completeness }       | 400 | 401 | 404
 *
 * PUT is where prose stops. Whatever the form sends goes through parseCriteria,
 * which either normalizes it into an explicit contract or refuses it by field
 * name, so an ambiguous requirement cannot be stored and then fail opaquely at
 * check time. A 400 here names the field, which is the difference between a
 * fixable message and "something went wrong".
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { parseCriteria, criteriaCompleteness, CriteriaError } from "@/lib/site-acceptance/criteria";
import { getAcceptanceCriteria, saveAcceptanceCriteria, listAcceptanceRuns } from "@/lib/site-acceptance/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const project = await getSiteProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const workspaceId = user.workspaceId ?? "default";
  const stored = await getAcceptanceCriteria(workspaceId, id);
  const runs = await listAcceptanceRuns(workspaceId, id, 25);

  return NextResponse.json({
    // `configured` distinguishes "nobody filled the form in" from "someone
    // accepted the defaults", which are different data points about the intake.
    configured: stored != null,
    criteria: stored?.criteria ?? parseCriteria(null),
    completeness: stored?.completeness ?? 0,
    updatedAt: stored?.updated_at ?? null,
    runs,
  });
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const project = await getSiteProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { criteria?: unknown } | null;

  let criteria;
  try {
    criteria = parseCriteria(body?.criteria ?? body);
  } catch (err) {
    if (err instanceof CriteriaError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    return NextResponse.json({ error: "invalid criteria" }, { status: 400 });
  }

  const workspaceId = user.workspaceId ?? "default";
  const saved = await saveAcceptanceCriteria(workspaceId, id, criteria, user.id);

  trackEvent("site.acceptance_criteria_saved", user.id, user.role, {
    project_id: id,
    completeness: criteriaCompleteness(criteria),
    has_prototype: criteria.prototypeUrl != null,
    required_routes: criteria.requiredRoutes.length,
    required_content: criteria.requiredContent.length,
    max_layout_diffs: criteria.maxLayoutDiffs,
  });

  // The contract decides whether a build ships, so changing it is a governance
  // action, not a preference: who widened the tolerance, and when, is a question
  // that gets asked after something ships wrong.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "site.acceptance_criteria_saved",
    resourceType: "site_project",
    resourceId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: { ...criteria },
  });

  return NextResponse.json({ criteria: saved.criteria, completeness: saved.completeness, updatedAt: saved.updated_at });
}
