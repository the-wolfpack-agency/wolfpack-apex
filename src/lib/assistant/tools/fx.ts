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
      const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(
        params.base,
      )}&symbols=${encodeURIComponent(params.targets.join(","))}`;
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ExchangeRateResponse;
      if (!json.rates || Object.keys(json.rates).length === 0) {
        throw new Error("empty rates payload");
      }
      const data: FxToolData = {
        base: json.base ?? params.base,
        rates: json.rates,
        as_of: json.date ?? new Date().toISOString().slice(0, 10),
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
