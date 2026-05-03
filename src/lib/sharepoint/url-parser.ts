/**
 * SharePoint URL parser — turn a copy/pasted "Open in browser" SharePoint
 * folder URL into the components the Microsoft Graph API expects.
 *
 * Why this exists: the wizard at /automations/porsche-classes/setup asks
 * a non-technical operator to paste a SharePoint folder link. Operators
 * have NO IDEA what a Graph site_id, drive_id, or root-relative path is.
 * They DO know how to navigate to a folder in SharePoint, click "Copy
 * link", and paste. This parser bridges that gap: extract the pieces we
 * can from the URL, hand the rest to a Graph lookup.
 *
 * The URLs SharePoint produces in 2025-2026 look like one of:
 *
 *   1. Folder browse URL (most common — what "Copy link" → "View only"
 *      yields when the operator is sitting on a folder):
 *         https://{tenant}.sharepoint.com/sites/{site}/Shared%20Documents/SubFolder/More?id=%2Fsites%2F{site}%2FShared%20Documents%2FSubFolder%2FMore&p=4
 *
 *   2. Layouts / share-by-link form (the "Anyone with the link" flow
 *      generates these — we still want to handle the path-via-?id=):
 *         https://{tenant}.sharepoint.com/:f:/r/sites/{site}/Shared%20Documents/SubFolder?csf=1&web=1&e=ABCDE
 *
 *   3. Plain hierarchy URL (no query string):
 *         https://{tenant}.sharepoint.com/sites/{site}/Shared%20Documents/SubFolder
 *
 * From any of those we can extract:
 *   - site_host: "{tenant}.sharepoint.com" — the Graph "host" segment
 *   - site_path: "sites/{site}" — the Graph site path segment
 *   - folder_path: "Shared Documents/SubFolder/More" — the document
 *                  library + sub-folder, decoded (no %20).
 *
 * The drive_id is NOT recoverable from the URL — every SharePoint site
 * has multiple document libraries and the URL only tells us which root
 * folder ("Shared Documents" → the default Documents library) the
 * operator picked. The Graph helper `resolveSiteAndDrive` does the
 * second hop.
 *
 * Returns null on anything that isn't recognizably a SharePoint URL —
 * the caller surfaces "We didn't recognize that link, please paste a
 * SharePoint folder URL" instead of a stack trace.
 */

export interface ParsedSharepointFolderUrl {
  /** "{tenant}.sharepoint.com" — host segment used by Graph. */
  site_host: string;
  /** "sites/{site}" — path segment after the host, no leading slash. */
  site_path: string;
  /** Document library + sub-folder, percent-decoded, no leading slash. */
  folder_path: string;
}

/**
 * Decode a path segment safely. SharePoint URLs are aggressive about
 * percent-encoding spaces and apostrophes. `decodeURIComponent` will
 * throw on malformed sequences (a stray `%`); we catch and return the
 * raw input so a freaky URL doesn't crash the wizard.
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Parse a SharePoint "Open in browser" folder URL.
 *
 * Strategy:
 *   1. Validate this is an https:// URL on a *.sharepoint.com host.
 *   2. Pull the site path. Three input shapes:
 *      - /sites/{site}/...                    — pattern 1, 3
 *      - /:f:/r/sites/{site}/...              — pattern 2 (share-by-link)
 *   3. Extract the folder path. Two strategies in order:
 *      - prefer the `?id=` query param when present (it's the canonical
 *        absolute path SharePoint considers authoritative)
 *      - fall back to the URL pathname after the site segment
 *   4. Normalize: strip the leading `/sites/{site}/`, decode percent
 *      sequences, drop trailing slashes, return.
 *
 * Returns null on anything that fails the host check or doesn't yield a
 * usable folder path.
 */
/* RFC 3986 caps a sane URL well under 8 KiB; SharePoint copy/paste
   links are ~500 chars at the high end. Cap input before any regex
   touches it to defeat ReDoS amplification on adversarial input. */
const MAX_URL_LEN = 8192;

export function parseSharepointFolderUrl(
  raw: string,
): ParsedSharepointFolderUrl | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_URL_LEN) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.host.toLowerCase();
  // SharePoint Online lives at *.sharepoint.com. Reject anything else
  // up-front so we don't mis-parse a OneDrive or Teams URL.
  if (!/^[a-z0-9-]+\.sharepoint\.com$/.test(host)) return null;

  /* Path normalization: turn the pathname into a list of decoded
     segments. The leading "/" yields an empty first element which we
     drop. */
  const decodedPath = safeDecode(url.pathname);
  const segments = decodedPath
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  /* Find the "sites/{site}" anchor. Pattern 2 prefixes with ":f:/r/"
     (or other ":x:/r/" verbs); pattern 1 / 3 start with sites/{site}.
     We scan for the literal "sites" segment and use the next one as the
     site name. Falls back to first-segment "/sites" only when the URL
     has no namespace prefix. */
  const siteIdx = segments.findIndex((s) => s.toLowerCase() === "sites");
  if (siteIdx < 0 || siteIdx >= segments.length - 1) return null;
  const siteName = segments[siteIdx + 1];
  if (!siteName) return null;

  /* Folder path strategy A — prefer the `?id=` query if present. The
     operator's "Copy link" output reliably includes `?id=` for folder
     navigation links. The id value is itself percent-encoded and starts
     with /sites/{site}/, so we strip that prefix to land on the
     library-relative path. */
  const idParam = url.searchParams.get("id");
  let folderPath: string | null = null;
  if (idParam) {
    const decodedId = safeDecode(idParam).replace(/^\/+/, "");
    const idSegments = decodedId.split("/").filter((s) => s.length > 0);
    /* Drop a leading "sites/{site}" if present — both possible. */
    if (
      idSegments[0]?.toLowerCase() === "sites" &&
      idSegments[1]?.toLowerCase() === siteName.toLowerCase()
    ) {
      folderPath = idSegments.slice(2).join("/");
    } else {
      folderPath = idSegments.join("/");
    }
  }

  /* Strategy B — pathname after the site segment. Used when no id query
     was supplied (pattern 3) or when the id strategy yielded an empty
     path (folder = library root). */
  if (!folderPath) {
    const after = segments.slice(siteIdx + 2);
    folderPath = after.join("/");
  }

  /* Drop trailing slashes / file fragments. Collapse repeated slashes
     that crept in from a malformed copy/paste. */
  folderPath = folderPath.replace(/\/+$/, "").replace(/\/{2,}/g, "/");

  // An empty folder path is acceptable in principle (= library root)
  // but for the porsche-classes destination we always need at least one
  // sub-folder (otherwise summaries land in the library root). Return
  // null so the wizard nudges the operator to navigate INTO a folder.
  if (!folderPath) return null;

  return {
    site_host: host,
    site_path: `sites/${siteName}`,
    folder_path: folderPath,
  };
}

/* ------------------------------------------------------------------ */
/* Graph resolver — second hop: parsed URL → {site_id, drive_id, path} */
/* ------------------------------------------------------------------ */

import { getValidToken } from "@/lib/microsoft-graph";

export interface ResolvedSiteAndDrive {
  site_id: string;
  drive_id: string;
  folder_path: string;
}

export type ResolveError =
  | { kind: "no_token" }
  | { kind: "site_not_found"; status: number; body: string }
  | { kind: "drive_not_found"; status: number; body: string }
  | { kind: "graph_error"; status: number; body: string }
  | { kind: "library_not_found"; library: string };

export type ResolveResult =
  | { ok: true; resolved: ResolvedSiteAndDrive }
  | { ok: false; error: ResolveError };

/**
 * Resolve a parsed SharePoint URL to the Graph identifiers
 * (`site_id`, `drive_id`) and the drive-relative folder path.
 *
 * Graph calls used:
 *   GET /sites/{host}:/{site_path}             → returns site.id
 *   GET /sites/{site_id}/drives                → list document libraries
 *
 * Library matching: the first segment of the parsed `folder_path` is
 * the document library display name (e.g. "Shared Documents", "PCNA"
 * etc.). We look it up among the site's drives by `name` to find the
 * `driveId`. Falls back to the default `documents` drive ("Shared
 * Documents") when the segment doesn't match anything — this is the
 * most common case and lets a vanilla SharePoint URL resolve.
 *
 * Never throws — every failure path returns a typed error so the route
 * layer can surface a sentence the operator understands.
 */
export async function resolveSiteAndDrive(
  userId: string,
  parsed: ParsedSharepointFolderUrl,
): Promise<ResolveResult> {
  const token = await getValidToken(userId);
  if (!token) return { ok: false, error: { kind: "no_token" } };

  /* Step 1: site_id lookup. */
  const siteUrl =
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(parsed.site_host)}` +
    `:/${parsed.site_path}`;
  let siteRes: Response;
  try {
    siteRes = await fetch(siteUrl, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "graph_error",
        status: 0,
        body: `network error: ${(err as Error).message}`,
      },
    };
  }
  if (!siteRes.ok) {
    const body = await siteRes.text().catch(() => "");
    return {
      ok: false,
      error: {
        kind: siteRes.status === 404 ? "site_not_found" : "graph_error",
        status: siteRes.status,
        body: body.slice(0, 500),
      },
    };
  }
  const sitePayload = (await siteRes.json()) as { id?: string };
  const siteId = sitePayload.id;
  if (!siteId) {
    return {
      ok: false,
      error: {
        kind: "site_not_found",
        status: siteRes.status,
        body: "Graph site response missing id",
      },
    };
  }

  /* Step 2: list drives, pick the one whose name matches the first
     segment of the folder path. The first segment is the document
     library display name (e.g. "Shared Documents"). */
  const segments = parsed.folder_path.split("/").filter((s) => s.length > 0);
  const libraryName = segments[0] ?? "";
  const remainder = segments.slice(1).join("/");

  const drivesUrl = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drives`;
  let drivesRes: Response;
  try {
    drivesRes = await fetch(drivesUrl, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "graph_error",
        status: 0,
        body: `network error: ${(err as Error).message}`,
      },
    };
  }
  if (!drivesRes.ok) {
    const body = await drivesRes.text().catch(() => "");
    return {
      ok: false,
      error: {
        kind: "graph_error",
        status: drivesRes.status,
        body: body.slice(0, 500),
      },
    };
  }
  const drivesPayload = (await drivesRes.json()) as {
    value?: { id: string; name?: string; driveType?: string }[];
  };
  const drives = drivesPayload.value ?? [];

  /* Match library name case-insensitively. "Shared Documents" is the
     SharePoint URL display name for the default drive whose Graph
     `name` is typically "Documents", so handle that aliasing
     explicitly. */
  const lcLibrary = libraryName.toLowerCase();
  const matched =
    drives.find((d) => (d.name ?? "").toLowerCase() === lcLibrary) ||
    (lcLibrary === "shared documents"
      ? drives.find((d) => (d.name ?? "").toLowerCase() === "documents")
      : undefined) ||
    /* Default to the first "documentLibrary" drive so a vanilla URL
       still resolves when the operator pasted a link into the default
       library. */
    drives.find((d) => d.driveType === "documentLibrary");

  if (!matched) {
    return {
      ok: false,
      error: { kind: "library_not_found", library: libraryName },
    };
  }

  return {
    ok: true,
    resolved: {
      site_id: siteId,
      drive_id: matched.id,
      folder_path: remainder,
    },
  };
}
