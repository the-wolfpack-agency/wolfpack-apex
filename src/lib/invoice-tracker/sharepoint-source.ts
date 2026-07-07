/**
 * Generic SharePoint-workbook reader for the Invoice Trackers.
 *
 * Mirrors the proven job-codes source (chosen 2026-05-20 by the CTO), trimmed to
 * the ONE production path — decode a configured share URL via Graph's /shares
 * endpoint, then read a worksheet's used range. Unlike job-codes this parser is
 * GENERIC: it has no required "code" column, so it mirrors ANY sheet shape (an
 * invoice/budget "Summary" tab has arbitrary headers).
 *
 * Cross-tenant note: PCNA's workbook lives in the PCNA tenant, so the Wolfpack
 * APP-ONLY token cannot read it. We try the triggering viewer's DELEGATED token
 * first (they have access via the share) and fall back to app-only for
 * same-tenant trackers. Returns a typed Result so callers distinguish "Graph
 * down / not connected" from "sheet is empty".
 */

import { getAppOnlyToken, getValidToken } from "@/lib/microsoft-graph";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type SheetErrorCode =
  | "no_token"
  | "not_found"
  | "forbidden"
  | "graph_error"
  | "empty";

export interface SheetError {
  code: SheetErrorCode;
  detail: string;
}

export interface SheetData {
  columns: string[];
  rows: Array<Record<string, string>>;
  driveId: string;
  itemId: string;
  webUrl: string;
  sheetName: string;
  tokenKind: "delegated" | "app_only";
}

export type SheetResult = { ok: true; value: SheetData } | { ok: false; error: SheetError };

/** Base64url-encode a SharePoint URL for Graph's /shares endpoint. Exported for tests. */
export function encodeShareUrl(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  return `u!${b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
}

/**
 * Parse a workbook usedRange `values[][]` into ordered columns + row objects.
 * Generic: the header row names the columns; every non-empty header becomes a
 * key. Fully-empty rows are dropped. `forwardFill` headers inherit the last
 * non-empty value above them (the section-header pattern). Exported for tests.
 */
export function parseSheet(
  values: Array<Array<string | number | boolean | null>>,
  forwardFill: string[] = [],
): { columns: string[]; rows: Array<Record<string, string>> } {
  if (!Array.isArray(values) || values.length === 0) return { columns: [], rows: [] };
  const headerRaw = (values[0] ?? []).map((v) => String(v ?? "").trim());
  const cols: Array<{ header: string; idx: number }> = [];
  const seen = new Set<string>();
  headerRaw.forEach((h, idx) => {
    if (h && !seen.has(h)) {
      seen.add(h);
      cols.push({ header: h, idx });
    }
  });
  if (cols.length === 0) return { columns: [], rows: [] };

  const ff = new Set(forwardFill);
  const lastVal = new Map<number, string>();
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const rec: Record<string, string> = {};
    let hasAny = false;
    for (const { header, idx } of cols) {
      let val = String(raw[idx] ?? "").trim();
      if (ff.has(header)) {
        if (val) lastVal.set(idx, val);
        else val = lastVal.get(idx) ?? "";
      }
      if (val) hasAny = true;
      rec[header] = val;
    }
    if (hasAny) rows.push(rec);
  }
  return { columns: cols.map((c) => c.header), rows };
}

/** Delegated (viewer) token first — cross-tenant reads need it; app-only fallback. */
export async function acquireToken(
  preferUserId?: string | null,
): Promise<{ token: string; kind: "delegated" | "app_only" } | null> {
  if (preferUserId) {
    try {
      const t = await getValidToken(preferUserId);
      if (t && typeof t === "object" && typeof t.accessToken === "string" && t.accessToken.length > 0) {
        return { token: t.accessToken, kind: "delegated" };
      }
    } catch {
      /* fall through to app-only */
    }
  }
  const appOnly = await getAppOnlyToken();
  return appOnly ? { token: appOnly, kind: "app_only" } : null;
}

async function graphGet<T>(path: string, token: string): Promise<{ ok: true; value: T } | { ok: false; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch (err) {
    return { ok: false, status: 0, detail: (err as Error).message };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, detail: `HTTP ${res.status} ${body}` };
  }
  return { ok: true, value: (await res.json()) as T };
}

interface ShareItem {
  id?: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
}
interface Worksheets {
  value?: Array<{ name?: string }>;
}
interface UsedRange {
  values?: Array<Array<string | number | boolean | null>>;
}

export interface FetchOptions {
  shareUrl: string;
  sheetName: string;
  preferUserId?: string | null;
  forwardFill?: string[];
}

export async function fetchSheet(opts: FetchOptions): Promise<SheetResult> {
  const acquired = await acquireToken(opts.preferUserId);
  if (!acquired) {
    return {
      ok: false,
      error: { code: "no_token", detail: "no Microsoft Graph token (viewer not connected AND app-only unconfigured)" },
    };
  }
  const { token, kind } = acquired;

  const mapErr = (status: number, detail: string): SheetError => {
    if (status === 403) return { code: "forbidden", detail };
    if (status === 404) return { code: "not_found", detail };
    return { code: "graph_error", detail };
  };

  // 1) resolve the share URL to a driveItem.
  const share = await graphGet<ShareItem>(`shares/${encodeURIComponent(encodeShareUrl(opts.shareUrl))}/driveItem`, token);
  if (!share.ok) return { ok: false, error: mapErr(share.status, share.detail) };
  const driveId = share.value.parentReference?.driveId;
  const itemId = share.value.id;
  if (!driveId || !itemId) {
    return { ok: false, error: { code: "not_found", detail: "share URL resolved but driveItem is missing driveId/id" } };
  }
  const webUrl = share.value.webUrl ?? opts.shareUrl;

  // 2) list worksheets, pick the configured sheet (or first).
  const sheets = await graphGet<Worksheets>(
    `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets`,
    token,
  );
  if (!sheets.ok) return { ok: false, error: mapErr(sheets.status, sheets.detail) };
  const names = (sheets.value.value ?? []).map((s) => s.name ?? "").filter(Boolean);
  if (names.length === 0) return { ok: false, error: { code: "empty", detail: "workbook has no worksheets" } };
  const sheetName = names.find((n) => n.toLowerCase() === opts.sheetName.toLowerCase()) ?? names[0];

  // 3) read the used range.
  const used = await graphGet<UsedRange>(
    `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange(valuesOnly=true)?$select=values`,
    token,
  );
  if (!used.ok) return { ok: false, error: mapErr(used.status, used.detail) };

  const parsed = parseSheet(used.value.values ?? [], opts.forwardFill ?? []);
  if (parsed.columns.length === 0) {
    return { ok: false, error: { code: "empty", detail: `sheet "${sheetName}" has no header row` } };
  }
  return { ok: true, value: { ...parsed, driveId, itemId, webUrl, sheetName, tokenKind: kind } };
}
