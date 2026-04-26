/** @jest-environment jsdom */
 

/**
 * Insights emitter contract:
 *   - Browser path POSTs to /api/analytics with the canonical event
 *     name + metadata shape; never imports trackEvent / db.
 *   - Server path dynamic-imports @/lib/analytics so the client
 *     bundle stays pg-free.
 */

const trackEventMock = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: trackEventMock }));

beforeEach(() => {
  trackEventMock.mockReset();
});

describe("emitInsight (browser path)", () => {
  it("POSTs the canonical event name + metadata to /api/analytics", async () => {
    window.localStorage.setItem("instinct_token", "tok");
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({}) }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const { emitInsight } = await import("@/lib/insights/emit");
    emitInsight({
      actor: "u1",
      role: "ceo",
      surface: "search",
      action: "queried",
      tier: "personal",
      payload: { query_length: 5, total_results: 12 },
    });
    // Microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/analytics");
    const body = JSON.parse(call[1].body as string);
    expect(body.event).toBe("insight.search.queried");
    expect(body.metadata).toEqual({
      surface: "search",
      action: "queried",
      tier: "personal",
      target: "",
      query_length: 5,
      total_results: 12,
    });
    // Must NOT have called server-side trackEvent.
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it("never throws when the network call fails (fire-and-forget)", async () => {
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn(() =>
      Promise.reject(new Error("offline")),
    ) as unknown as typeof fetch;
    const { emitInsight } = await import("@/lib/insights/emit");
    expect(() =>
      emitInsight({
        actor: "u1",
        role: "ceo",
        surface: "chat",
        action: "noop",
        tier: "personal",
        payload: {},
      }),
    ).not.toThrow();
  });
});
