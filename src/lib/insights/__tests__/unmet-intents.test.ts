/**
 * Unmet-intents aggregator — clustering, ranking, filtering.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { normalizePhrase, getUnmetIntents } from "@/lib/insights/unmet-intents";

beforeEach(() => {
  mockSafeQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

describe("normalizePhrase", () => {
  test("strips trailing punctuation + lowercases", () => {
    expect(normalizePhrase("Show me my deals!")).toBe("show me my deals");
    expect(normalizePhrase("WHO is hoxsie???")).toBe("who is hoxsie");
  });
  test("collapses whitespace", () => {
    expect(normalizePhrase("  show   my  inbox  ")).toBe("show my inbox");
  });
});

describe("getUnmetIntents", () => {
  test("returns [] when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const r = await getUnmetIntents();
    expect(r).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("groups by normalized phrase + ranks by distinct users then count", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        /* "show my deals" — 3 different users, 4 events */
        { message_text: "Show my deals", user_id: "u1", timestamp: "2026-05-17T10:00:00Z", has_brain_context: false },
        { message_text: "show my deals", user_id: "u2", timestamp: "2026-05-17T09:00:00Z", has_brain_context: false },
        { message_text: "Show my deals!", user_id: "u3", timestamp: "2026-05-17T08:00:00Z", has_brain_context: true },
        { message_text: "show my deals", user_id: "u1", timestamp: "2026-05-17T07:00:00Z", has_brain_context: false },
        /* "what's our runway" — 1 user, 5 events */
        ...Array.from({ length: 5 }, (_, i) => ({
          message_text: "what's our runway",
          user_id: "u9",
          timestamp: `2026-05-17T0${i}:00:00Z`,
          has_brain_context: false,
        })),
      ],
    });
    const r = await getUnmetIntents();
    expect(r).toHaveLength(2);
    /* Distinct-user count wins: "show my deals" first (3 users)
     * even though "runway" has more total events (5). */
    expect(r[0].normalizedText).toBe("show my deals");
    expect(r[0].distinctUsers).toBe(3);
    expect(r[0].count).toBe(4);
    expect(r[1].normalizedText).toBe("what's our runway");
    expect(r[1].distinctUsers).toBe(1);
    expect(r[1].count).toBe(5);
  });

  test("drops phrases shorter than minLength (default 6)", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { message_text: "ok", user_id: "u1", timestamp: "2026-05-17T10:00:00Z", has_brain_context: false },
        { message_text: "thanks", user_id: "u1", timestamp: "2026-05-17T10:00:00Z", has_brain_context: false },
        { message_text: "what's the burn rate", user_id: "u2", timestamp: "2026-05-17T10:00:00Z", has_brain_context: false },
      ],
    });
    const r = await getUnmetIntents();
    expect(r.map((i) => i.normalizedText)).toEqual(["thanks", "what's the burn rate"]);
  });

  test("brainContextRate is the fraction of hits with brain context", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { message_text: "porsche pitch notes", user_id: "u1", timestamp: "t", has_brain_context: true },
        { message_text: "porsche pitch notes", user_id: "u2", timestamp: "t", has_brain_context: true },
        { message_text: "porsche pitch notes", user_id: "u3", timestamp: "t", has_brain_context: false },
        { message_text: "porsche pitch notes", user_id: "u4", timestamp: "t", has_brain_context: false },
      ],
    });
    const r = await getUnmetIntents();
    expect(r[0].brainContextRate).toBe(0.5);
  });

  test("exampleText preserves the user's original casing + punctuation", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { message_text: "Show my deals.", user_id: "u1", timestamp: "t", has_brain_context: false },
        { message_text: "show my deals", user_id: "u2", timestamp: "t", has_brain_context: false },
      ],
    });
    const r = await getUnmetIntents();
    expect(r[0].exampleText).toBe("Show my deals.");
  });

  test("respects limit", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: Array.from({ length: 10 }, (_, i) => ({
        message_text: `phrase number ${i}`,
        user_id: `u${i}`,
        timestamp: "t",
        has_brain_context: false,
      })),
    });
    const r = await getUnmetIntents({ limit: 3 });
    expect(r).toHaveLength(3);
  });

  test("returns [] gracefully on DB error", async () => {
    mockSafeQuery.mockRejectedValue(new Error("connection refused"));
    const r = await getUnmetIntents();
    expect(r).toEqual([]);
  });
});
