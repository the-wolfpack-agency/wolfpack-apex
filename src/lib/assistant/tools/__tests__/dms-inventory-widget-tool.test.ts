/**
 * dms_inventory_widget — intent + handler shape.
 *
 * Mocks global fetch (the call to the AgenticQA driver server) so
 * the test doesn't require the bridge running. End-to-end with a
 * live bridge is exercised in a manual integration test before
 * each demo.
 */

const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

(global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import { dmsInventoryWidgetTool } from "@/lib/assistant/tools/dms-inventory-widget-tool";

const match = (q: string) => dmsInventoryWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockFetch.mockReset();
});

describe("dms_inventory intent matching", () => {
  test.each([
    "show me 2024 hondas",
    "find toyota rav4 under 30k",
    "search inventory for fords",
    "any 2022 jeeps",
    "show me dms inventory",
    "look up tesla model y",
    "got any chevy silverados in stock",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "what's our revenue this quarter",
    "find emails from hoxsie",
    "create task to wash my car",
    "I drive a Toyota",
    "calendar",
    /* Regression 2026-05-18: a meeting / date query with no make
     * keyword used to false-positive because the year ("2026") +
     * verb ("have") combo tripped the loose intent gate. Locked. */
    "which meetings did wolfpack have on April 20, 2026?",
    "what meetings did we have in 2025",
    "do we have any meetings in 2026",
    /* Regression 2026-05-19: bare "search <make>" / "find <make>" /
     * "look up <make>" with NO extra vehicle signal must fall through
     * to the universal `search` tool. Porsche is a make AND a client AND
     * a topical search term — when phrased generically, fan out to chat/
     * email/CRM/calendar/knowledge/DMS rather than only inventory. */
    "search Porsche",
    "search porsche",
    "find Porsche",
    "look up Porsche",
    "find Toyota",
    "find Honda",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });

  test.each([
    /* These DO match — they carry an explicit vehicle signal beyond the
     * make keyword (year, model, price, or inventory keyword), so the
     * DMS tool's specialized handling is preferred over universal
     * search's fan-out. */
    "search Porsche 911",
    "find 2022 Porsche",
    "search Porsche inventory",
    "find Porsche under 100k",
    "show me Porsches",
  ])("'%s' STILL matches (extra vehicle signal present)", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test("extracts make + model", () => {
    const p = match("show me toyota rav4");
    expect(p?.make?.toLowerCase()).toBe("toyota");
    expect(p?.model?.toLowerCase()).toBe("rav4");
  });

  test("extracts year", () => {
    const p = match("any 2022 hondas");
    expect(p?.year).toBe(2022);
  });

  test("extracts price with k suffix", () => {
    const p = match("find toyota under 30k");
    expect(p?.priceMax).toBe(30000);
  });

  test("extracts price without k suffix", () => {
    const p = match("show me hondas under 25000");
    expect(p?.priceMax).toBe(25000);
  });
});

describe("dms_inventory handler", () => {
  test("happy path: posts to driver server + returns widget spec", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        duration_ms: 800,
        data: {
          items: [
            {
              title: "2024 Honda Civic",
              year: 2024,
              make: "Honda",
              model: "Civic",
              price: 28000,
              vin: "1HGCV1F34PA999999",
              image_url: "https://img/1.jpg",
              detail_url: "https://wolfpack-auto.vercel.app/inventory/1HGCV1F34PA999999",
            },
          ],
        },
      }),
    });
    const r = await dmsInventoryWidgetTool.handler(
      { make: "Honda", limit: 8 },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("dms_inventory");
    const spec = r.widget as { kind: "dms_inventory"; items: unknown[] };
    expect(spec.items).toHaveLength(1);
    expect(r.answer).toMatch(/Found 1 vehicle/i);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/dms/wolfpack-auto/inventory-search"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("empty result → 'no vehicles match' answer", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, duration_ms: 700, data: { items: [] } }),
    });
    const r = await dmsInventoryWidgetTool.handler({ make: "Ferrari", limit: 8 }, CTX);
    if (!r.ok) return;
    expect(r.answer).toMatch(/No vehicles match/i);
  });

  test("driver server failure → widget renders error state, tool still ok", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error_message: "Browser engine crashed" }),
    });
    const r = await dmsInventoryWidgetTool.handler({ make: "Honda", limit: 8 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const spec = r.widget as { kind: "dms_inventory"; title: string };
    expect(spec.title).toMatch(/failed/i);
    expect(r.answer).toMatch(/Couldn't reach the DMS driver/);
  });

  test("network error → caught, widget renders error state", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await dmsInventoryWidgetTool.handler({ make: "Honda", limit: 8 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/ECONNREFUSED/);
  });

  test("fires widget_offered analytics with vendor + count", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, duration_ms: 100, data: { items: [{ title: "x" }] } }),
    });
    await dmsInventoryWidgetTool.handler({ make: "Honda", limit: 8 }, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({
        widget_kind: "dms_inventory",
        vendor: "wolfpack-auto",
        item_count: 1,
      }),
    );
  });
});

/* ---------------------------------------------------------------------
 * Found by scripts/phrase-sweep.ts: the two most natural ways to ask what is
 * in stock both cost a model call.
 *
 * The keyword set knew inventory, dms and stock - none of which somebody
 * standing in a dealership reaches for first. They say "on the lot", and
 * everyone else says "vehicles".
 * --------------------------------------------------------------- */
describe("asking what is in stock, in the words people use", () => {
  const match = (m: string) => dmsInventoryWidgetTool.matchIntent!(m);

  it.each(["how many Cayennes are on the lot", "what vehicles are available"])(
    "%s reaches the inventory widget",
    (m) => {
      expect(match(m)).not.toBeNull();
    },
  );

  /* THE REGRESSION THE WIDENING NEARLY SHIPPED. "vehicles available" pulled
     in a report of a broken page, and this tool is registered at 43 while
     feedback is at 53, so it would have won: somebody telling us the product
     was broken would have been shown a list of cars. */
  it.each([
    "the available vehicles page is broken",
    "the vehicles list is blank",
    "the inventory widget is not working",
  ])("%s is a fault report, not a stock query", (m) => {
    expect(match(m)).toBeNull();
  });

  /* Unchanged by the widening, and asserted so it stays that way. */
  it("still ignores a casual mention of a car", () => {
    expect(match("I drive a Porsche")).toBeNull();
  });
});
