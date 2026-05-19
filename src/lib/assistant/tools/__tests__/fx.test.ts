/**
 * fx tool — intent matching, happy path, API failure, cache hit.
 * Mocks global fetch so no live network request fires.
 */

const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(), query: jest.fn() }));

(global as unknown as { fetch: typeof fetch }).fetch =
  mockFetch as unknown as typeof fetch;

import { fxTool, __resetFxCacheForTests } from "@/lib/assistant/tools/fx";

const match = (q: string) => fxTool.matchIntent(q);
const CTX = { userId: "u1", userRole: "cto" };

function ratesResp(base: string, rates: Record<string, number>, date = "2026-05-19") {
  return {
    ok: true,
    json: async () => ({ base, date, rates }),
  };
}

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockFetch.mockReset();
  __resetFxCacheForTests();
});

describe("fx intent matching", () => {
  test.each([
    "fx",
    "fx?",
    "fx rate",
    "exchange rate",
    "what's the exchange rate",
    "what's the fx rate",
    "fx rate from USD to EUR",
    "exchange rate for USD to JPY",
    "fx rate from GBP into EUR",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test("default base is USD when none captured", () => {
    expect(match("fx")?.base).toBe("USD");
    expect(match("fx")?.targets).toEqual(["EUR", "GBP", "JPY", "CAD", "AUD"]);
  });

  test("captured pair is preserved + uppercased", () => {
    const p = match("fx rate from usd to eur");
    expect(p?.base).toBe("USD");
    expect(p?.targets).toEqual(["EUR"]);
  });

  test.each([
    "weather",
    "top headlines",
    "what's our revenue this quarter",
    "find emails about fx",
    "create a fx record",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("fx handler", () => {
  test("happy path: fetches rates + returns widget spec", async () => {
    mockFetch.mockResolvedValue(
      ratesResp("USD", { EUR: 0.92, GBP: 0.78, JPY: 155.4, CAD: 1.36, AUD: 1.5 }),
    );
    const r = await fxTool.handler(
      { base: "USD", targets: ["EUR", "GBP", "JPY", "CAD", "AUD"] },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("fx");
    const spec = r.widget as {
      kind: "fx";
      base: string;
      asOf: string;
      rates: Array<{ code: string; value: number }>;
    };
    expect(spec.base).toBe("USD");
    expect(spec.asOf).toBe("2026-05-19");
    expect(spec.rates).toHaveLength(5);
    expect(spec.rates.find((r) => r.code === "EUR")?.value).toBeCloseTo(0.92, 4);
    expect(r.answer).toMatch(/USD/);
  });

  test("API failure → returns internal error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const r = await fxTool.handler({ base: "USD", targets: ["EUR"] }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/external_api_failed/);
  });

  test("empty rates payload → returns internal error", async () => {
    mockFetch.mockResolvedValue(ratesResp("USD", {}));
    const r = await fxTool.handler({ base: "USD", targets: ["EUR"] }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/external_api_failed/);
  });

  test("network error → returns internal error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await fxTool.handler({ base: "USD", targets: ["EUR"] }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/ECONNREFUSED/);
  });

  test("cache hit: second call same key skips network", async () => {
    mockFetch.mockResolvedValue(ratesResp("EUR", { USD: 1.08 }));
    const r1 = await fxTool.handler({ base: "EUR", targets: ["USD"] }, CTX);
    expect(r1.ok).toBe(true);
    const afterFirst = mockFetch.mock.calls.length;
    const r2 = await fxTool.handler({ base: "EUR", targets: ["USD"] }, CTX);
    expect(r2.ok).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(afterFirst);

    const cacheHitEvents = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "assistant.fx_executed" && c[3]?.cache_hit === true,
    );
    expect(cacheHitEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("fires assistant.fx_executed on happy path", async () => {
    mockFetch.mockResolvedValue(ratesResp("USD", { EUR: 0.9 }));
    await fxTool.handler({ base: "USD", targets: ["EUR"] }, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.fx_executed",
      "u1",
      "cto",
      expect.objectContaining({ success: true, base: "USD" }),
    );
  });
});
