/**
 * GET  /api/connectors/sharepoint/sources — list workspace sources.
 * POST /api/connectors/sharepoint/sources — add a new source (parses
 *      the SharePoint folder URL, resolves site_id + drive_id via
 *      Graph, persists, fires analytics).
 *
 * Auth: any authenticated user can list. Add/remove requires the
 * connectors.manage capability (workspace admin in practice).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createRepo } from "@/lib/connectors/sharepoint/repo";
import {
  parseSharepointFolderUrl,
  resolveSiteAndDrive,
} from "@/lib/sharepoint/url-parser";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
  const repo = createRepo();
  const sources = await repo.listSources(workspaceId);
  return NextResponse.json({ sources });
}

interface AddBody {
  name?: unknown;
  siteUrl?: unknown;
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";

  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const siteUrl = typeof body.siteUrl === "string" ? body.siteUrl.trim() : "";
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  if (!siteUrl) return NextResponse.json({ error: "site_url_required" }, { status: 400 });

  const parsed = parseSharepointFolderUrl(siteUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: "We couldn't parse that SharePoint folder URL. Copy it from your browser address bar while viewing the folder." },
      { status: 400 },
    );
  }

  const resolved = await resolveSiteAndDrive(user.id, parsed);
  if (!resolved.ok) {
    const message =
      resolved.error.kind === "no_token"
        ? "Microsoft account isn't connected. Connect Outlook first, then add this source."
        : resolved.error.kind === "site_not_found"
        ? "We couldn't find that SharePoint site. Check the URL and your access."
        : resolved.error.kind === "library_not_found"
        ? `We found the site, but no document library named "${resolved.error.library}". Check the URL.`
        : "Microsoft Graph returned an error while resolving the folder.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const repo = createRepo();
  let source;
  try {
    source = await repo.insertSource({
      workspaceId,
      name,
      siteUrl,
      siteId: resolved.resolved.site_id,
      driveId: resolved.resolved.drive_id,
      folderPath: resolved.resolved.folder_path,
      createdBy: user.id,
    });
  } catch (err) {
    /* Unique-index violation = duplicate. Friendly error. */
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "That folder is already configured as a source." },
        { status: 409 },
      );
    }
    throw err;
  }

  trackEvent("connectors.sharepoint.source_added", user.id, user.role, {
    source_id: source.id,
    workspace_id: workspaceId,
    site_id: resolved.resolved.site_id,
  });

  return NextResponse.json({ source }, { status: 201 });
}
