import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import {
  listReleases,
  createRelease,
  type ReleaseEntry,
} from "@/lib/releases";

/**
 * GET /api/releases — list published releases, newest first.
 *
 * Org-wide read (releases.view). Powers the /releases wiki page.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "releases.view");
  if (!auth.ok) return auth.response;

  const releases = await listReleases();

  trackEvent("releases.viewed", auth.user.id, auth.user.role, {
    count: releases.length,
  });

  return NextResponse.json({ releases });
}

/**
 * POST /api/releases — publish (or upsert) a release.
 *
 * Gated (releases.manage). Used by the release-notes generator and the manual
 * publish path. Body: { version, title, summary?, released_on?, entries[], published? }.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "releases.manage");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const version = typeof body.version === "string" ? body.version.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!version || !title) {
    return NextResponse.json(
      { error: "version and title are required" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.entries)) {
    return NextResponse.json(
      { error: "entries must be an array" },
      { status: 400 },
    );
  }

  const entries: ReleaseEntry[] = body.entries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      title: String(e.title ?? "").trim(),
      description: String(e.description ?? "").trim(),
      how_to_use: String(e.how_to_use ?? "").trim(),
      area: e.area != null ? String(e.area).trim() : undefined,
      category: e.category != null ? String(e.category).trim() : undefined,
    }))
    .filter((e) => e.title.length > 0);

  const release = await createRelease({
    version,
    title,
    summary: typeof body.summary === "string" ? body.summary : "",
    released_on:
      typeof body.released_on === "string" ? body.released_on : undefined,
    entries,
    published: typeof body.published === "boolean" ? body.published : true,
    created_by: auth.user.id,
  });

  trackEvent("releases.published", auth.user.id, auth.user.role, {
    version: release.version,
    entry_count: release.entries.length,
  });

  // Compliance record: who published which release.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "releases.published",
    resourceType: "release",
    resourceId: release.version,
    afterState: {
      version: release.version,
      title: release.title,
      entry_count: release.entries.length,
      published: release.published,
    },
  });

  return NextResponse.json({ release }, { status: 201 });
}
