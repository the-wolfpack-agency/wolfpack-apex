/**
 * /api/sites/[id]/versions — version-history surface for site briefs.
 *
 * GET   — unified timeline (UNION of brief generations + brief edits,
 *         newest first). Auth required.
 * POST  — { action: "restore", toVersionId } rolls the current brief
 *         back to the specified version. Auth + role >= sales.
 *
 * Every write goes through `writeQuery` inside the lib with
 * expectRows: 1. On success we emit `site.version_history_viewed`
 * (GET) or `site.version_restored` (POST) so the learning loop
 * sees the full lifecycle.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";
import {
  listVersionsForSite,
  restoreVersion,
  RestoreVersionError,
} from "@/lib/brief-versions";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const project = await getSiteProject(id);
  if (!project) {
    // In this codebase sites are not per-user-scoped at the DB layer —
    // visibility is gated by site existence. Returning 403 (rather than
    // 404) matches the task spec + hides whether the id exists at all
    // from an unauthorized caller.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const versions = await listVersionsForSite(id, { limit: 100 });

  trackEvent("site.version_history_viewed", user.id, user.role, {
    site_id: id,
    version_count: versions.length,
  });

  return NextResponse.json({ versions });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;

  let body: { action?: unknown; toVersionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "restore") {
    return NextResponse.json(
      { error: "unsupported action" },
      { status: 400 },
    );
  }
  const toVersionId =
    typeof body.toVersionId === "string" ? body.toVersionId.trim() : "";
  if (!toVersionId) {
    return NextResponse.json(
      { error: "toVersionId required" },
      { status: 400 },
    );
  }

  const project = await getSiteProject(id);
  if (!project) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const entry = await restoreVersion({
      siteId: id,
      toVersionId,
      userId: user.id,
      userRole: user.role,
    });
    return NextResponse.json({ version: entry });
  } catch (err) {
    if (err instanceof RestoreVersionError) {
      if (err.reason === "version_not_found") {
        return NextResponse.json(
          { error: err.message, reason: err.reason },
          { status: 404 },
        );
      }
      if (err.reason === "site_not_found") {
        return NextResponse.json(
          { error: err.message, reason: err.reason },
          { status: 404 },
        );
      }
    }
    if (err instanceof WriteQueryError) {
      // Silent-discard surfaced loudly. The lib threw it because the
      // write produced an unexpected row count — never return 200 with
      // unknown state.
      console.error(
        "[sites/id/versions] restore write failed:",
        err.message,
      );
      return NextResponse.json(
        { error: "restore write failed", reason: err.code },
        { status: 500 },
      );
    }
    console.error("[sites/id/versions]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
