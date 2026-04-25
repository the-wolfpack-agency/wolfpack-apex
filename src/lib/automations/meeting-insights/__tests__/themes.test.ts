/**
 * Tests for the themes query helpers.
 *
 * The Postgres `query` helper from @/lib/db is mocked. We assert that
 * each helper builds a sensible SQL shape, parameterises correctly, and
 * normalises the result rows.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import {
  recurringTopics,
  staleTopics,
  openActionItems,
  semanticSearch,
} from "../themes";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("recurringTopics", () => {
  it("calls the GIN-friendly UNNEST query", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          topic: "pricing",
          mention_count: "3",
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-04-01T00:00:00Z",
          message_ids: ["m-1", "m-2", "m-3"],
        },
      ],
    });
    const out = await recurringTopics({ feed_id: "f-1" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      topic: "pricing",
      mention_count: 3,
      message_ids: ["m-1", "m-2", "m-3"],
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("UNNEST(a.topics)");
    expect(sql).toContain("a.status = 'success'");
    expect(mockQuery.mock.calls[0][1][0]).toBe("f-1");
  });

  it("respects custom limit", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await recurringTopics({ feed_id: "f-1", limit: 7 });
    expect(mockQuery.mock.calls[0][1][2]).toBe(7);
  });
});

describe("staleTopics", () => {
  it("excludes topics raised in the recent window", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          topic: "old-issue",
          last_mentioned: "2026-02-01T00:00:00Z",
          days_silent: "60",
          message_ids: ["m-1"],
        },
      ],
    });
    const out = await staleTopics({
      feed_id: "f-1",
      recent_window: 3,
    });
    expect(out).toHaveLength(1);
    expect(out[0].days_silent).toBe(60);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("recent_msgs");
    expect(sql).toContain("NOT IN");
  });
});

describe("openActionItems", () => {
  it("filters completed items out via SQL", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          message_id: "m-1",
          message_subject: "Weekly",
          message_received_at: "2026-04-01T00:00:00Z",
          description: "Update pricing page",
          owner: "alice",
          due: null,
          source_quote: null,
        },
      ],
    });
    const out = await openActionItems({ feed_id: "f-1" });
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Update pricing page");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("JSONB_ARRAY_ELEMENTS(l.action_items)");
    expect(sql).toContain("(ai->>'completed')::boolean");
  });
});

describe("semanticSearch", () => {
  it("returns [] for empty query without hitting DB", async () => {
    const out = await semanticSearch({ feed_id: "f-1", query: "  " });
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("falls back to ILIKE search when QDRANT_URL is unset", async () => {
    const original = process.env.QDRANT_URL;
    delete process.env.QDRANT_URL;
    try {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            message_id: "m-1",
            subject: "Pricing review",
            received_at: "2026-04-01T00:00:00Z",
            topics: ["pricing"],
            body_text: "We discussed pricing v2 and the launch date.",
          },
        ],
      });
      const out = await semanticSearch({ feed_id: "f-1", query: "pricing" });
      expect(out).toHaveLength(1);
      expect(out[0].subject).toBe("Pricing review");
      expect(out[0].highlight.toLowerCase()).toContain("pricing");
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("ILIKE");
    } finally {
      if (original !== undefined) process.env.QDRANT_URL = original;
    }
  });
});
