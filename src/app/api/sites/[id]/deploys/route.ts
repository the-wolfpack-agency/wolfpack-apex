/**
 * GET /api/sites/[id]/deploys — admin diagnostic for deploy history.
 *
 * Returns recent rows from apex_site_deploys including log_excerpt so
 * operators can see WHY a deploy failed instead of staring at the
 * generic "Internal server error" the PATCH route returns.
 *
 * Admin-gated: ceo / cto / hr (level ≥ hr). Other roles get 403.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject, listSiteDeploys } from "@/lib/sites";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasRole(user.role, "hr")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const project = await getSiteProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const deploys = await listSiteDeploys(id, 20);
  return NextResponse.json({ deploys });
}
