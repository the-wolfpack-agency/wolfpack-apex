/**
 * fx — empty-state demo tool returning current FX rates against a base
 * currency. Backed by exchangerate.host (no key required, free).
 *
 * Intent shapes:
 *   "fx"                       — default base=USD, curated set
 *   "fx rate"                  — same
 *   "exchange rate"            — same
 *   "fx rate from USD to EUR"  — captured pair
 *   "exchange rate for USD to JPY"
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BASE = "USD";
const DEFAULT_TARGETS = ["EUR", "GBP", "JPY", "CAD", "AUD"];

const INTENT_RE =
  /^\s*(?:what'?s\s+the\s+)?(?:exchange\s+rate|fx\s+rate|fx)(?:\s+(?:from|for|on)\s+(\w{3})\s+(?:to|in|into)\s+(\w{3}))?\??\s*$/i;

const ParamSchema = z.object({
  base: z.string().length(3),
  targets: z.array(z.string().length(3)).min(1).max(20),
});
type Params = z.infer<typeof ParamSchema>;

export interface FxToolData {
  base: string;
  rates: Record<string, number>;
  as_of: string;
}

interface CacheEntry {
  expires: number;
  data: FxToolData;
}
const cache = new Map<string, CacheEntry>();

/** Test seam — wipe the in-memory cache between tests so per-test
 *  fetch-call assertions aren't poisoned by prior fixtures. */
export function __resetFxCacheForTests(): void {
  cache.clear();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ExchangeRateResponse {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

export const fxTool: ToolDef<Params, FxToolData> = {
  name: "fx",
  description:
    "Current FX (exchange) rates against a base currency. Empty-state demo tool — no integration required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent(message: string): Params | null {
    const m = INTENT_RE.exec(message);
    if (!m) return null;
    const fromCcy = m[1]?.toUpperCase();
    const toCcy = m[2]?.toUpperCase();
    if (fromCcy && toCcy) {
      return { base: fromCcy, targets: [toCcy] };
    }
    return { base: DEFAULT_BASE, targets: DEFAULT_TARGETS };
  },
  async handler(params, ctx): Promise<ToolResult<FxToolData>> {
    const key = `${params.base}:${params.targets.slice().sort().join(",")}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      trackEvent("assistant.fx_executed", ctx.userId, ctx.userRole, {
        base: cached.data.base,
        success: true,
        cache_hit: true,
      });
      return buildSuccess(cached.data);
    }

    try {
      /* PROVIDER CHANGED UNDER US, and nothing told us.
       *
       * This called api.exchangerate.host, which moved to a paid model and now
       * answers every unauthenticated request with "missing_access_key" and no
       * rates. The tool did the right thing with that, returning a typed
       * failure rather than inventing a number, so nothing broke loudly. It
       * just stopped working.
       *
       * Which matters more than it sounds: "exchange rate from USD to EUR" is
       * one of the starter chips shown to somebody who has connected nothing,
       * in the category described as working right now. It is among the first
       * things a new person clicks, and it has been returning an error.
       *
       * open.er-api.com serves the same data with no key. Found by driving
       * real prompts through production, which is the only way a dead
       * third-party dependency surfaces: every test we had mocked it. */
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(params.base)}`;
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ExchangeRateResponse & {
        result?: string;
        time_last_update_utc?: string;
      };
      if (json.result && json.result !== "success") {
        throw new Error(`provider said ${json.result}`);
      }
      if (!json.rates || Object.keys(json.rates).length === 0) {
        throw new Error("empty rates payload");
      }
      /* Narrowed to what was asked for. The endpoint returns every currency it
         knows, and handing 160 rates to a caller that asked for one is a
         needlessly large answer to render and to cache. */
      const wanted: Record<string, number> = {};
      for (const t of params.targets) {
        const rate = json.rates[t.toUpperCase()];
        if (typeof rate === "number") wanted[t.toUpperCase()] = rate;
      }
      if (Object.keys(wanted).length === 0) {
        throw new Error(`no rate for ${params.targets.join(", ")}`);
      }
      const data: FxToolData = {
        base: json.base ?? params.base,
        rates: wanted,
        as_of:
          json.time_last_update_utc?.slice(5, 16) ??
          json.date ??
          new Date().toISOString().slice(0, 10),
      };

      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });

      trackEvent("assistant.fx_executed", ctx.userId, ctx.userRole, {
        base: data.base,
        success: true,
        cache_hit: false,
      });

      return buildSuccess(data);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "network error";
      trackEvent("assistant.fx_executed", ctx.userId, ctx.userRole, {
        base: params.base,
        success: false,
        reason: "external_api_failed",
      });
      return {
        ok: false,
        code: "internal",
        message: `external_api_failed: ${message}`,
      };
    }
  },
};

function buildSuccess(data: FxToolData): ToolResult<FxToolData> {
  const widget: WidgetSpec = {
    kind: "fx",
    base: data.base,
    asOf: data.as_of,
    rates: Object.entries(data.rates).map(([code, value]) => ({
      code,
      value: Number(value),
    })),
  };
  const summary = Object.entries(data.rates)
    .slice(0, 3)
    .map(([code, value]) => `${code} ${Number(value).toFixed(4)}`)
    .join(", ");
  return {
    ok: true,
    data,
    answer: `FX rates (base ${data.base}, ${data.as_of}): ${summary}.`,
    widget,
  };
}

registerTool(fxTool);
