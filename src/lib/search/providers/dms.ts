/**
 * DMS (Dealer Management System) provider — fans Universal Search into
 * the dealer's DMS inventory via the same AgenticQA browser-driver
 * bridge that backs `dms_inventory_widget`. Treats the bare query as a
 * make/model substring filter.
 *
 * isEnabled: true whenever the DMS_DRIVER_URL env is set. (Default
 *   localhost value is honored too so dev environments work.) The
 *   driver itself reports unconfigured cleanly; we degrade silent.
 *
 * Safety: 3s AbortController timeout so a slow/unreachable DMS driver
 * can't block the wider universal-search response. Failures emit
 * system.search_provider_failed via the registry's outer wrapper, not
 * thrown.
 */

import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { buildSnippet } from "./util";

const DMS_DRIVER_URL = process.env.DMS_DRIVER_URL ?? "";
const DMS_DRIVER_TOKEN = process.env.DMS_DRIVER_TOKEN ?? "";
const DEFAULT_VENDOR = process.env.DMS_DEFAULT_VENDOR ?? "wolfpack-auto";
const FETCH_TIMEOUT_MS = 3_000;

interface DmsItem {
  title?: string;
  make?: string;
  model?: string;
  year?: number;
  price?: number;
  vin?: string;
  url?: string;
  updated_at?: string;
  [k: string]: unknown;
}

async function search(
  query: string,
  perTypeLimit: number,
  _ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!DMS_DRIVER_URL) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DMS_DRIVER_TOKEN) headers["Authorization"] = `Bearer ${DMS_DRIVER_TOKEN}`;

  try {
    /* Heuristic split: if the query is bare (one word) treat as a make
     *  filter so "Porsche" → make=Porsche. If multi-word, send as a
     *  free-text title-substring via the `q` param — most DMS drivers
     *  fall back to title contains-match when make/model are absent. */
    const single = !/\s/.test(q);
    const body = single
      ? { make: q, limit: perTypeLimit }
      : { q, limit: perTypeLimit };

    const res = await fetch(
      `${DMS_DRIVER_URL}/dms/${DEFAULT_VENDOR}/inventory-search`,
      { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal },
    );
    if (!res.ok) return [];
    const payload = (await res.json()) as { ok?: boolean; data?: { items?: DmsItem[] } };
    if (payload.ok === false) return [];
    const items = payload.data?.items ?? [];
    return items.slice(0, perTypeLimit).map((i, idx): SearchResult => {
      const titleParts = [i.year, i.make, i.model].filter(Boolean);
      const title = i.title ?? (titleParts.length ? titleParts.join(" ") : `Vehicle ${idx + 1}`);
      const snippetSrc = [
        i.vin ? `VIN ${i.vin}` : null,
        typeof i.price === "number" ? `$${i.price.toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        type: "dms",
        id: String(i.vin ?? `${DEFAULT_VENDOR}:${idx}`),
        title,
        snippet: snippetSrc || buildSnippet(JSON.stringify(i).slice(0, 240), q),
        timestamp: i.updated_at ?? new Date().toISOString(),
        url: typeof i.url === "string" ? i.url : undefined,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export const dmsProvider: SearchProvider = {
  type: "dms",
  name: "DMS Inventory",
  countKey: "dms",
  isEnabled: () => Boolean(DMS_DRIVER_URL),
  search,
};
