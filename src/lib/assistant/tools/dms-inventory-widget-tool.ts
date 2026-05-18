/**
 * dms_inventory_widget — calls the AgenticQA DMS driver server to
 * scrape a dealer site's inventory page via headless browser, then
 * renders the result inline in chat.
 *
 * This is the "we can drive any DMS your team uses" proof-of-concept.
 * First vendor: wolfpack-auto (we own it, no auth gating). The same
 * pattern swaps to CDK / Tekion / Reynolds by adding a vendor module
 * server-side; this tool stays unchanged.
 *
 * Trigger phrases:
 *   "show me 2024 hondas"
 *   "find toyota rav4 under 30k"
 *   "inventory of fords"
 *   "dms inventory"
 *
 * The tool deliberately keeps its intent regex tight so it doesn't
 * compete with the CRM/calendar/etc widgets — DMS-style phrasings
 * include a vehicle make/model OR the explicit "dms" keyword.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const DMS_DRIVER_URL =
  process.env.DMS_DRIVER_URL ?? "http://127.0.0.1:7421";
const DMS_DRIVER_TOKEN = process.env.DMS_DRIVER_TOKEN ?? "";
/* Default vendor for the MVP demo. Future: parse vendor from the
 * intent ("show me CDK inventory of Hondas") or pull from the
 * workspace's configured DMS in integration_templates. */
const DEFAULT_VENDOR = process.env.DMS_DEFAULT_VENDOR ?? "wolfpack-auto";

const ParamSchema = z.object({
  make: z.string().min(1).max(40).optional(),
  model: z.string().min(1).max(60).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  priceMax: z.number().int().min(1000).max(10_000_000).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
type Params = z.infer<typeof ParamSchema>;

interface DmsWidgetData {
  kind: "dms_inventory";
  vendor: string;
  itemCount: number;
  durationMs: number;
}

/* Intent regex — broad enough to catch "show me 2022 Toyota RAV4
 * under 30k" and tight enough to avoid claiming generic CRM phrases.
 * Required signal: at least one of (make keyword, year, "dms",
 * "inventory"). */
const MAKE_RE =
  /\b(toyota|honda|ford|chevrolet|chevy|nissan|jeep|ram|gmc|hyundai|kia|subaru|mazda|tesla|bmw|audi|mercedes|lexus|acura|volkswagen|vw|dodge|chrysler|cadillac|buick|lincoln|infiniti|porsche|volvo|mini|fiat|alfa|jaguar|land\s*rover|mitsubishi|genesis)s?\b/i;
const MODEL_AFTER_MAKE_RE =
  /\b(?:toyota|honda|ford|chevrolet|chevy|nissan|jeep|ram|gmc|hyundai|kia|subaru|mazda|tesla|bmw|audi|mercedes|lexus|acura|volkswagen|vw|dodge|chrysler|cadillac|buick|lincoln|infiniti|porsche|volvo|mini|fiat|alfa|jaguar|land\s*rover|mitsubishi|genesis)\s+([a-z0-9-]{2,30})/i;
const YEAR_RE = /\b(20\d{2}|19\d{2})\b/;
const PRICE_RE = /under\s+\$?([0-9]+)(k)?\b/i;
const INVENTORY_KEYWORD_RE = /\b(inventory|dms|stock)\b/i;

function matchDmsIntent(message: string): Params | null {
  const trimmed = message.trim();
  const makeMatch = MAKE_RE.exec(trimmed);
  const yearMatch = YEAR_RE.exec(trimmed);
  const inventoryKw = INVENTORY_KEYWORD_RE.test(trimmed);
  if (!makeMatch && !yearMatch && !inventoryKw) return null;
  /* Tighten: also require a "search-y" verb so casual mentions
   * ("I drive a Toyota") don't fire the tool. */
  if (!/\b(show|find|search|look\s+up|list|browse|any|got|have|inventory|stock|dms)\b/i.test(trimmed)) {
    return null;
  }

  const params: Params = { limit: 8 };
  if (makeMatch) {
    /* makeMatch[1] is the captured make WITHOUT the optional plural
     * "s" suffix, so "hondas" → "honda" not "hondas". */
    params.make = makeMatch[1].trim();
    const modelM = MODEL_AFTER_MAKE_RE.exec(trimmed);
    if (modelM && modelM[1] && !/^(under|with|that|for|near|in|at|on)$/i.test(modelM[1])) {
      params.model = modelM[1].trim();
    }
  }
  if (yearMatch) params.year = Number(yearMatch[1]);
  const priceM = PRICE_RE.exec(trimmed);
  if (priceM) {
    const raw = Number(priceM[1]);
    params.priceMax = priceM[2] ? raw * 1000 : raw;
  }
  return params;
}

export const dmsInventoryWidgetTool: ToolDef<Params, DmsWidgetData> = {
  name: "dms_inventory_widget",
  description:
    "Drive the dealer's DMS web UI (via the AgenticQA browser-driver bridge) to fetch and render vehicle inventory matching the user's filters. Works against any configured DMS — vendor selection is server-side.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchDmsIntent,
  async handler(params, ctx): Promise<ToolResult<DmsWidgetData>> {
    const started = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (DMS_DRIVER_TOKEN) {
      headers["Authorization"] = `Bearer ${DMS_DRIVER_TOKEN}`;
    }

    let items: Array<Record<string, unknown>> = [];
    let durationMs = 0;
    let ok = true;
    let errorMessage: string | undefined;

    try {
      const res = await fetch(
        `${DMS_DRIVER_URL}/dms/${DEFAULT_VENDOR}/inventory-search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            make: params.make,
            model: params.model,
            year: params.year,
            price_max: params.priceMax,
            limit: params.limit,
          }),
        },
      );
      const payload = (await res.json()) as {
        ok?: boolean;
        data?: { items?: Array<Record<string, unknown>> };
        duration_ms?: number;
        error_message?: string;
      };
      if (!res.ok || payload.ok === false) {
        ok = false;
        errorMessage =
          payload.error_message ?? `Driver returned HTTP ${res.status}`;
      } else {
        items = payload.data?.items ?? [];
        durationMs = payload.duration_ms ?? Date.now() - started;
      }
    } catch (err) {
      ok = false;
      errorMessage = (err as Error).message.slice(0, 200);
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "dms_inventory",
      vendor: DEFAULT_VENDOR,
      item_count: items.length,
      duration_ms: durationMs,
      ok,
    });

    const spec: WidgetSpec = {
      kind: "dms_inventory",
      vendor: DEFAULT_VENDOR,
      title: ok
        ? items.length === 0
          ? "No matches"
          : `${items.length} match${items.length === 1 ? "" : "es"} on ${DEFAULT_VENDOR}`
        : "Inventory lookup failed",
      subtitle: ok ? buildSubtitle(params) : errorMessage,
      items: items.map((i) => ({
        title: String(i.title ?? ""),
        year: typeof i.year === "number" ? i.year : null,
        make: typeof i.make === "string" ? i.make : null,
        model: typeof i.model === "string" ? i.model : null,
        price: typeof i.price === "number" ? i.price : null,
        vin: typeof i.vin === "string" ? i.vin : null,
        imageUrl: typeof i.image_url === "string" ? i.image_url : null,
        detailUrl: typeof i.detail_url === "string" ? i.detail_url : null,
      })),
    };

    const answer = ok
      ? items.length === 0
        ? `No vehicles match those filters on ${DEFAULT_VENDOR} right now.`
        : `Found ${items.length} vehicle${items.length === 1 ? "" : "s"} on ${DEFAULT_VENDOR}${buildSubtitle(params) ? ` (${buildSubtitle(params)})` : ""}.`
      : `Couldn't reach the DMS driver: ${errorMessage}`;

    return {
      ok: true,
      data: {
        kind: "dms_inventory",
        vendor: DEFAULT_VENDOR,
        itemCount: items.length,
        durationMs,
      },
      answer,
      widget: spec,
    };
  },
};

function buildSubtitle(params: Params): string {
  const parts: string[] = [];
  if (params.year) parts.push(String(params.year));
  if (params.make) parts.push(params.make);
  if (params.model) parts.push(params.model);
  if (params.priceMax) parts.push(`under $${params.priceMax.toLocaleString()}`);
  return parts.join(" ");
}

registerTool(dmsInventoryWidgetTool);
