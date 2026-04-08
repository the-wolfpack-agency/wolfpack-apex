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
  BriefValidationError,
  type SiteBrief,
} from "@/lib/sites";

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
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
