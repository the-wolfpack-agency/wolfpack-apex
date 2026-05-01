/**
 * Microsoft Graph fetcher for the principles SharePoint .docx.
 *
 * Reads a SharePoint document by its full sharing URL (the kind users
 * paste from the browser address bar). Resolves the URL to a Graph
 * `driveItem` reference, then downloads the binary .docx content for
 * the parser. Cached only via the existing graphFetch cache.
 *
 * Auth: same per-user M365 OAuth path the rest of the app uses
 * (getValidToken + Mail.Read / Files.Read scopes). No app-level
 * service principal — keeps the security surface aligned with the
 * MCP-free directive.
 */

import { getValidToken } from "@/lib/microsoft-graph";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type FetchSpDocResult =
  | { ok: true; bytes: Buffer; etag: string | null; webUrl: string | null }
  | { ok: false; code: "not_connected" | "scope_missing" | "not_found" | "graph_error"; status?: number; message: string };

/**
 * Encode a sharing URL for the Microsoft Graph
 * `/shares/{share-id}/driveItem` endpoint.
 *
 * Per Microsoft docs: prepend "u!", base64url-encode, strip trailing
 * '=' padding. This lets us resolve any user-pasted SharePoint URL
 * without first parsing site/library/path.
 */
export function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url, "utf-8").toString("base64");
  return "u!" + b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

/**
 * Fetch a SharePoint Word doc by its public/share URL.
 *
 * Two-step: resolve the share-id to a driveItem (so we can pull the
 * canonical webUrl + ETag for change-detect), then download the bytes
 * via /content. The two requests are sequenced because the second one
 * needs the driveItem id from the first.
 */
export async function fetchSharePointDocx(
  userId: string,
  sharingUrl: string,
): Promise<FetchSpDocResult> {
  const token = await getValidToken(userId);
  if (!token) {
    return {
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    };
  }
  const shareId = encodeSharingUrl(sharingUrl);

  let metaRes: Response;
  try {
    metaRes = await fetch(`${GRAPH_BASE}/shares/${shareId}/driveItem`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      code: "graph_error",
      message: `network: ${(err as Error).message}`,
    };
  }
  if (metaRes.status === 403) {
    return {
      ok: false,
      code: "scope_missing",
      message: "Files.Read scope required to read SharePoint docs",
    };
  }
  if (metaRes.status === 404) {
    return {
      ok: false,
      code: "not_found",
      message: "share-id resolved to nothing — link may be private or revoked",
    };
  }
  if (!metaRes.ok) {
    return {
      ok: false,
      code: "graph_error",
      status: metaRes.status,
      message: `graph ${metaRes.status}`,
    };
  }
  const meta = (await metaRes.json().catch(() => ({}))) as {
    id?: string;
    eTag?: string;
    webUrl?: string;
    parentReference?: { driveId?: string };
  };
  if (!meta.id || !meta.parentReference?.driveId) {
    return {
      ok: false,
      code: "graph_error",
      message: "driveItem missing id/driveId",
    };
  }

  /* Step 2 — download the bytes. */
  let contentRes: Response;
  try {
    contentRes = await fetch(
      `${GRAPH_BASE}/drives/${meta.parentReference.driveId}/items/${meta.id}/content`,
      {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      },
    );
  } catch (err) {
    return {
      ok: false,
      code: "graph_error",
      message: `network: ${(err as Error).message}`,
    };
  }
  if (!contentRes.ok) {
    return {
      ok: false,
      code: "graph_error",
      status: contentRes.status,
      message: `graph ${contentRes.status}`,
    };
  }
  const arrayBuf = await contentRes.arrayBuffer();
  return {
    ok: true,
    bytes: Buffer.from(arrayBuf),
    etag: meta.eTag ?? null,
    webUrl: meta.webUrl ?? null,
  };
}
