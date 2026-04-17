/**
 * /api/sites/[id] — fetch, update, deploy a single project.
 *
 * GET    → return project
 * PATCH  → update brief OR trigger a deploy when ?action=deploy
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getSiteProject,
  updateBrief,
  triggerDeploy,
  deleteSiteProject,
  BriefValidationError,
  type SiteBrief,
} from "@/lib/sites";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const project = await getSiteProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const action = req.nextUrl.searchParams.get("action");

  if (action === "deploy") {
    try {
      const result = await triggerDeploy(id, user.id, user.role);
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[sites/id/deploy]", msg);
      // Known environment-misconfiguration cases — surface an actionable
      // reason to the UI instead of a generic "Internal server error"
      // banner that hides the real problem for days.
      if (msg.includes("GITHUB_TOKEN_WOLFPACK_AGENCY not set")) {
        return NextResponse.json(
          {
            error:
              "Site deploy is disabled in this environment: the GitHub " +
              "integration token is not configured. Ask an admin to set " +
              "GITHUB_TOKEN_WOLFPACK_AGENCY in Vercel.",
            reason: "github_token_missing",
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: "Deploy failed. Check /api/sites/:id/deploys for the log excerpt.", reason: "deploy_failed" },
        { status: 500 },
      );
    }
  }

  let body: { brief?: SiteBrief };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body?.brief) {
    return NextResponse.json({ error: "brief required" }, { status: 400 });
  }
  try {
    const project = await updateBrief(id, body.brief, user.id, user.role);
    return NextResponse.json({ project });
  } catch (err) {
    if (err instanceof BriefValidationError) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 422 });
    }
    console.error("[sites/id/brief]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const archived = await deleteSiteProject(id, user.id, user.role);
  if (!archived) return NextResponse.json({ error: "not found" }, { status: 404 });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "site.archived",
    resourceType: "site_project",
    resourceId: id,
    afterState: { status: "archived", display_name: archived.display_name },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true });
}
