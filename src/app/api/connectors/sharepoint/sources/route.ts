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
import {
  isShortShareLink,
  resolveShareLink,
} from "@/lib/connectors/sharepoint/resolve-share-link";

export async function GET(req: NextRequest) {
  try {
    const user = getUserFromRequest(req.headers.get("authorization"));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
    const repo = createRepo();
    const sources = await repo.listSources(workspaceId);
    return NextResponse.json({ sources });
  } catch (err) {
    console.error("[connectors/sharepoint/sources GET] uncaught error:", err);
    return NextResponse.json(
      { error: `Couldn't list sources: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}

interface AddBody {
  name?: unknown;
  siteUrl?: unknown;
}

export async function POST(req: NextRequest) {
  /* Top-level try/catch so this route NEVER returns an HTML error page.
   * Any uncaught exception in resolveSiteAndDrive or the repo (Graph
   * call timeouts, network errors, transient DB issues) would otherwise
   * cause Next.js to render its default HTML 500, which the client
   * parses as `Unexpected token '<'`. Always return JSON. */
  try {
    return await runAddSource(req);
  } catch (err) {
    console.error("[connectors/sharepoint/sources POST] uncaught error:", err);
    return NextResponse.json(
      {
        error: `Server error while adding the source: ${(err as Error)?.message ?? "unknown"}. Try again, or scope to a smaller subfolder if the URL is the whole library.`,
      },
      { status: 500 },
    );
  }
}

async function runAddSource(req: NextRequest): Promise<NextResponse> {
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

  /* Two URL shapes the operator might paste:
   *   1. Canonical "open in browser" form: /sites/X/Shared Documents/...
   *      parseSharepointFolderUrl handles this directly.
   *   2. Short share link (Teams "Copy link", SharePoint "Share > Copy"):
   *      /:f:/s/X/<guid> — has no folder path. We call Graph's
   *      /shares/{token}/driveItem to resolve it to a canonical webUrl,
   *      then re-parse.
   */
  let parsed = parseSharepointFolderUrl(siteUrl);
  let canonicalUrl = siteUrl;
  if (!parsed && isShortShareLink(siteUrl)) {
    const resolved = await resolveShareLink(user.id, siteUrl);
    if (resolved.ok && resolved.webUrl) {
      canonicalUrl = resolved.webUrl;
      parsed = parseSharepointFolderUrl(resolved.webUrl);
    } else if (resolved.error === "no_token") {
      return NextResponse.json(
        { error: "Microsoft account isn't connected. Connect Outlook first, then add this source." },
        { status: 400 },
      );
    }
  }
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "We couldn't parse that SharePoint folder URL. Open the folder in your browser and copy the URL from the address bar (the one with `/sites/.../Shared Documents/...`).",
      },
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
      /* Store the canonical resolved URL (not the short share token)
       * so the source row stays meaningful after the share GUID
       * expires or is revoked. */
      siteUrl: canonicalUrl,
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
