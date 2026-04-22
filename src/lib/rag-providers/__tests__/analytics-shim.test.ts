/**
 * analytics-shim.test.ts
 *
 * Covers emitRagEvent():
 *   - forwards to trackEvent with name + userId + role + scalar metadata
 *   - swallows errors thrown by trackEvent (telemetry must never crash writes)
 *   - coerces non-scalar metadata values to strings instead of dropping them
 *   - drops null/undefined values
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("emitRagEvent", () => {
  test("forwards to trackEvent with correct name/userId/role/metadata", () => {
    emitRagEvent("rag.provider.vector_upsert", "u_123", "cto", {
      provider: "qdrant",
      written: 42,
      durationMs: 17.4,
      ok: true,
    });
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const call = mockTrackEvent.mock.calls[0];
    expect(call[0]).toBe("rag.provider.vector_upsert");
    expect(call[1]).toBe("u_123");
    expect(call[2]).toBe("cto");
    expect(call[3]).toEqual({
      provider: "qdrant",
      written: 42,
      durationMs: 17.4,
      ok: true,
    });
  });

  test("swallows errors thrown by trackEvent", () => {
    mockTrackEvent.mockImplementationOnce(() => {
      throw new Error("analytics broken");
    });
    expect(() =>
      emitRagEvent("rag.provider.graph_query", "u_9", "sre", { ok: false }),
    ).not.toThrow();
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });

  test("coerces nested object metadata to JSON strings (doesn't drop)", () => {
    emitRagEvent("rag.provider.search", "u_1", "admin", {
      filter: { tenant: "acme", topK: 5 },
      mode: "hybrid",
    });
    const meta = mockTrackEvent.mock.calls[0][3] as Record<string, unknown>;
    expect(typeof meta.filter).toBe("string");
    expect(meta.filter).toBe('{"tenant":"acme","topK":5}');
    expect(meta.mode).toBe("hybrid");
  });

  test("drops null and undefined metadata values", () => {
    emitRagEvent("rag.provider.search", "u_1", "admin", {
      provider: "qdrant",
      missing: null,
      alsoMissing: undefined,
      keep: 1,
    });
    const meta = mockTrackEvent.mock.calls[0][3] as Record<string, unknown>;
    expect(meta).toEqual({ provider: "qdrant", keep: 1 });
    expect("missing" in meta).toBe(false);
    expect("alsoMissing" in meta).toBe(false);
  });

  test("empty metadata is allowed", () => {
    emitRagEvent("rag.provider.health", "u_1", "sre", {});
    expect(mockTrackEvent).toHaveBeenCalledWith("rag.provider.health", "u_1", "sre", {});
  });

  test("swallows metadata-serialization-style errors with a String() fallback", () => {
    // Arrange a value whose JSON.stringify throws (circular reference).
    const circ: Record<string, unknown> = { name: "cyc" };
    circ.self = circ;
    emitRagEvent("rag.provider.search", "u_1", "admin", { circ });
    const meta = mockTrackEvent.mock.calls[0][3] as Record<string, unknown>;
    // Didn't throw, didn't drop the key, and rendered something.
    expect("circ" in meta).toBe(true);
    expect(typeof meta.circ).toBe("string");
  });
});

export {};
