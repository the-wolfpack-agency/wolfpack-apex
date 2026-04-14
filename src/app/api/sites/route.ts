/**
 * /api/sites — list + create sites projects.
 *
 * Auth: required for both GET and POST. Role check: any authenticated team
 * member can create a site (Max + Meghan are sales role).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  createSiteProject,
  listSiteProjects,
  BriefValidationError,
  type SiteBrief,
} from "@/lib/sites";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projects = await listSiteProjects();
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const project = await createSiteProject(body.brief, user.id, user.role);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    if (err instanceof BriefValidationError) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: 422 });
    }
    console.error("[sites]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
