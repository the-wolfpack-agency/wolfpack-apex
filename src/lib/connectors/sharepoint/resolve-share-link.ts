/**
 * Resolve a SharePoint short-share link (`:f:/s/{site}/<guid>`) to its
 * canonical `webUrl` via Microsoft Graph's `/shares/{token}/driveItem`
 * endpoint.
 *
 * Background: Teams + "Copy link" buttons in SharePoint produce share
 * tokens like `https://tenant.sharepoint.com/:f:/s/SITE/<guid>`. Those
 * tokens don't include the folder path. Graph's `/shares` API takes a
 * base64url-encoded version (with `u!` prefix) and returns the real
 * driveItem, from which we get the canonical `webUrl` that
 * parseSharepointFolderUrl can then handle normally.
 *
 * Reference:
 *   https://learn.microsoft.com/graph/api/shares-get?view=graph-rest-1.0
 */

import { getValidToken } from "@/lib/microsoft-graph";

/** True for the short share-link pattern Teams + "Copy link" generate. */
export function isShortShareLink(rawUrl: string): boolean {
  return /\/:[fwboxp]:\/[sr]\//i.test(rawUrl);
}

/** Encode a URL per Graph's sharing-URL rules: base64, swap + for -,
 *  swap / for _, strip trailing =, prefix with `u!`. */
function encodeShareUrl(rawUrl: string): string {
  const b64 = Buffer.from(rawUrl, "utf-8").toString("base64");
  const safe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `u!${safe}`;
}

export interface ResolveShareLinkResult {
  ok: boolean;
  webUrl?: string;
  driveId?: string;
  itemId?: string;
  error?: string;
}

interface SharesDriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
  folder?: { childCount?: number };
}

export async function resolveShareLink(
  userId: string,
  rawUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ResolveShareLinkResult> {
  const token = await getValidToken(userId);
  if (!token) return { ok: false, error: "no_token" };
  const encoded = encodeShareUrl(rawUrl);
  const url = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem`;
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return { ok: false, error: `network_error: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `graph_${res.status}` };
  }
  const payload = (await res.json()) as SharesDriveItem;
  if (!payload.webUrl) return { ok: false, error: "no_web_url_in_response" };
  return {
    ok: true,
    webUrl: payload.webUrl,
    driveId: payload.parentReference?.driveId,
    itemId: payload.id,
  };
}
