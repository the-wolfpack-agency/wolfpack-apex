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
import { resolveServiceUrl } from "@/lib/config/local-default";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

/**
 * Resolved per call, not at module load.
 *
 * A module-level constant is captured once when the lambda cold-starts, so a
 * variable added later needs a redeploy to take effect and a test cannot vary
 * it. It also made the loopback fallback invisible: the value was baked in
 * before anything could ask whether it made sense here.
 */
function dmsDriver() {
  return resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421");
}
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
/* "ON THE LOT" IS HOW A DEALER SAYS INVENTORY, and "vehicles" is how everyone
   else does. This knew three words, none of which somebody standing in a
   dealership would reach for first. Found by scripts/phrase-sweep.ts: "how
   many Cayennes are on the lot" and "what vehicles are available" both cost a
   model call. The make/verb gates below are unchanged, so a casual mention
   still cannot fire the tool. */
const INVENTORY_KEYWORD_RE =
  /\b(inventory|dms|stock|on\s+the\s+lot|vehicles?\s+(?:are\s+)?available|available\s+vehicles?)\b/i;

function matchDmsIntent(message: string): Params | null {
  const trimmed = message.trim();
  const makeMatch = MAKE_RE.exec(trimmed);
  const yearMatch = YEAR_RE.exec(trimmed);
  const inventoryKw = INVENTORY_KEYWORD_RE.test(trimmed);
  /* Required signal: a make keyword OR an explicit inventory/dms/stock
   * keyword. A year alone is NOT enough — "which meetings did
   * wolfpack have on April 20, 2026?" used to false-positive because
   * "2026" looks like a model year + "have" satisfied the verb gate.
   * Real vehicle queries always carry a make OR an inventory keyword;
   * date-bound meeting queries carry neither. */
  if (!makeMatch && !inventoryKw) return null;
  /* A BROKEN PAGE IS NOT AN INVENTORY QUERY.
   *
   * Widening the keywords to "vehicles available" brought "the available
   * vehicles page is broken" with it, and this tool is registered at 43 while
   * feedback is at 53, so it would win: somebody reporting a fault would be
   * shown a list of cars. Exactly the trap search-github-issues-tool already
   * documents for "report a bug", and guarded the same way and for the same
   * reason - the moment somebody says the product is broken is the moment
   * their words matter most. */
  if (
    /\b(?:page|screen|widget|button|tab|form|filter|list)\b[^.?!]{0,40}?\b(?:broken|not\s+working|wrong|blank|empty)\b/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  /* Tighten: also require a "search-y" verb so casual mentions
   * ("I drive a Toyota") don't fire the tool. */
  if (!/\b(show|find|search|look\s+up|list|browse|any|got|have|inventory|stock|dms|how\s+many|available)\b/i.test(trimmed)) {
    return null;
  }
  /* Universal-search shadow guard: bare "search <make>" / "find <make>" /
   * "look up <make>" with NO additional vehicle signal (year, model,
   * price, inventory keyword) should fall through to the universal
   * `search` tool so it can fan out across chat/email/CRM/calendar/
   * knowledge/DMS instead of being captured here. Porsche, Toyota etc.
   * are valid topical searches when the user isn't asking about inventory. */
  const universalSearchVerb = /\b(search|find|look\s+up)\b/i.test(trimmed);
  const dealershipVerb = /\b(show|list|browse|any|got|have|inventory|stock|dms)\b/i.test(trimmed);
  const hasExtraVehicleSignal = !!yearMatch
    || MODEL_AFTER_MAKE_RE.test(trimmed)
    || PRICE_RE.test(trimmed)
    || inventoryKw;
  if (universalSearchVerb && !dealershipVerb && !hasExtraVehicleSignal) {
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

    // Not configured is not the same as unreachable. Dialling the loopback
    // default in a deployed function produced ECONNREFUSED and told the
    // operator the driver was down, when the truth was that nobody had pointed
    // us at one. (Vercel usage alert, 2026-08-02.)
    const driver = dmsDriver();
    if (!driver.configured) {
      trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
        widget_kind: "dms_inventory",
        vendor: DEFAULT_VENDOR,
        item_count: 0,
        duration_ms: 0,
        not_configured: true,
      });
      return {
        ok: false,
        code: "internal",
        message: `No DMS driver is configured, so there is no inventory to search. ${driver.reason}`,
      };
    }
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
        `${driver.url}/dms/${DEFAULT_VENDOR}/inventory-search`,
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
