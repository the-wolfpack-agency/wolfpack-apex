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
    // Translate Postgres 23505 (unique_violation on client_slug) into a
    // 409 with an actionable message. Without this the user sees a
    // generic "Internal server error" and has no idea the slug is taken
    // by a prior archived row. Hard-deleted rows now free their slug
    // (see deleteSiteProject), so this only triggers on live/soft-
    // archived collisions.
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr?.code === "23505" && /client_slug/.test(pgErr?.constraint ?? "")) {
      return NextResponse.json(
        {
          error: `A site with slug "${body.brief.client}" already exists. Pick a different slug, or hard-delete the existing one first.`,
          reason: "slug_taken",
        },
        { status: 409 },
      );
    }
    console.error("[sites]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
