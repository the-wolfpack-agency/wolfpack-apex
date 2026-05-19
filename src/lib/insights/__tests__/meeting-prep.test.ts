/**
 * meeting-prep — end-to-end with mocks. Asserts the cache contract:
 *   - cache miss → ONE LLM call + persisted row
 *   - cache hit  → ZERO LLM calls + hit_count incremented
 *   - source-data change → new hash → new generation
 *   - synthesis failure → returns sources with synthesis_unavailable flag
 *   - workspace isolation → workspace A never reads workspace B's row
 */

const mockFetchMeetingSources = jest.fn();
const mockSynthesizePrep = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/insights/meeting-prep-sources", () => {
  const actual = jest.requireActual("@/lib/insights/meeting-prep-sources");
  return {
    ...actual,
    fetchMeetingSources: (...a: unknown[]) => mockFetchMeetingSources(...a),
  };
});
jest.mock("@/lib/insights/meeting-prep-synthesize", () => ({
  synthesizePrep: (...a: unknown[]) => mockSynthesizePrep(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  WriteQueryError: class WriteQueryError extends Error {},
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { prepareMeeting } from "@/lib/insights/meeting-prep";

const VERSION_MARKERS_A = {
  crmLastModified: { "a@x.com": "2026-05-18T00:00:00Z" },
  lastEmailReceivedAt: { "a@x.com": "2026-05-19T00:00:00Z" },
  lastBrainEditAt: "2026-05-19T00:00:00Z",
};
const VERSION_MARKERS_B = {
  ...VERSION_MARKERS_A,
  lastEmailReceivedAt: { "a@x.com": "2026-05-20T00:00:00Z" }, // changed
};

function sourcesWith(markers: typeof VERSION_MARKERS_A) {
  return {
    event: {
      id: "evt-1",
      subject: "Acme sync",
      start: "2026-05-20T15:00:00Z",
      end: "2026-05-20T15:30:00Z",
      attendees: ["Alice"],
      attendeeEmails: ["a@x.com"],
      body_preview: "",
    },
    perAttendee: [
      {
        email: "a@x.com",
        name: "Alice",
        crm: null,
        recentEmails: [],
        brainFacts: [],
      },
    ],
    versionMarkers: markers,
  };
}

const PREP_PAYLOAD = {
  summary: "ok",
  goal: "ok",
  talking_points: [],
  risk_flags: [],
  attendee_briefs: [],
  open_questions: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  delete process.env.DATABASE_URL;
});

describe("prepareMeeting cache contract", () => {
  test("cache miss → ONE LLM call + persisted row + miss cache_status", async () => {
    mockFetchMeetingSources.mockResolvedValue(sourcesWith(VERSION_MARKERS_A));
    /* lookup returns nothing (miss); insert returns a row id. */
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/SELECT[\s\S]+FROM instinct_meeting_insights/.test(sql)) {
        return { rows: [], fromCache: false };
      }
      if (/INSERT INTO instinct_meeting_insights/i.test(sql)) {
        return {
          rows: [{ id: "row-1", generated_at: "2026-05-19T00:00:00Z" }],
          fromCache: false,
        };
      }
      return { rows: [], fromCache: false };
    });
    mockSynthesizePrep.mockResolvedValue({
      ok: true,
      prep: PREP_PAYLOAD,
      latencyMs: 100,
      modelUsed: "haiku",
      inputTokens: 50,
      outputTokens: 20,
    });

    const result = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
      userRole: "cto",
    });
    expect(result).not.toBeNull();
    expect(result!.cacheStatus).toBe("miss");
    expect(mockSynthesizePrep).toHaveBeenCalledTimes(1);
    /* Persist should have been called once with workspace-scoped INSERT. */
    const inserts = mockSafeQuery.mock.calls.filter((c: unknown[]) =>
      /INSERT INTO instinct_meeting_insights/i.test(c[0] as string),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(
      expect.arrayContaining(["ws-a", "evt-1"]),
    );
    /* miss event fired. */
    expect(
      mockTrackEvent.mock.calls.some(
        (c: unknown[]) => c[0] === "assistant.meeting_prep_cache_miss",
      ),
    ).toBe(true);
  });

  test("cache hit → ZERO LLM calls + hit cache_status + hit_count bumped", async () => {
    mockFetchMeetingSources.mockResolvedValue(sourcesWith(VERSION_MARKERS_A));
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/SELECT[\s\S]+FROM instinct_meeting_insights/.test(sql)) {
        return {
          rows: [
            {
              id: "row-1",
              insight_json: PREP_PAYLOAD,
              generated_at: "2026-05-19T00:00:00Z",
              hit_count: 4,
            },
          ],
          fromCache: false,
        };
      }
      return { rows: [], fromCache: false };
    });

    const result = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
      userRole: "cto",
    });
    expect(result).not.toBeNull();
    expect(result!.cacheStatus).toBe("hit");
    expect(mockSynthesizePrep).not.toHaveBeenCalled();
    /* UPDATE for hit_count bump issued. */
    expect(
      mockSafeQuery.mock.calls.some((c: unknown[]) =>
        /UPDATE instinct_meeting_insights[\s\S]+SET hit_count/.test(
          c[0] as string,
        ),
      ),
    ).toBe(true);
    /* hit event fired with hit_count = 5 (bumped). */
    expect(
      mockTrackEvent.mock.calls.some(
        (c: unknown[]) =>
          c[0] === "assistant.meeting_prep_cache_hit" &&
          (c[3] as Record<string, unknown>).hit_count === 5,
      ),
    ).toBe(true);
  });

  test("source-data change → new hash → new generation", async () => {
    /* First call: returns markers A and cached row exists for hash(A). */
    mockFetchMeetingSources.mockResolvedValueOnce(sourcesWith(VERSION_MARKERS_A));
    /* Second call: returns markers B; lookup misses; new LLM call. */
    mockFetchMeetingSources.mockResolvedValueOnce(sourcesWith(VERSION_MARKERS_B));

    let lookupCount = 0;
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/SELECT[\s\S]+FROM instinct_meeting_insights/.test(sql)) {
        lookupCount += 1;
        /* First request: hit. Second request: miss. */
        if (lookupCount === 1) {
          return {
            rows: [
              {
                id: "row-1",
                insight_json: PREP_PAYLOAD,
                generated_at: "2026-05-19T00:00:00Z",
                hit_count: 0,
              },
            ],
            fromCache: false,
          };
        }
        return { rows: [], fromCache: false };
      }
      if (/INSERT INTO instinct_meeting_insights/i.test(sql)) {
        return {
          rows: [{ id: "row-2", generated_at: "2026-05-20T00:00:00Z" }],
          fromCache: false,
        };
      }
      return { rows: [], fromCache: false };
    });
    mockSynthesizePrep.mockResolvedValue({
      ok: true,
      prep: PREP_PAYLOAD,
      latencyMs: 100,
      modelUsed: "haiku",
      inputTokens: 50,
      outputTokens: 20,
    });

    const first = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });
    expect(first!.cacheStatus).toBe("hit");
    expect(mockSynthesizePrep).not.toHaveBeenCalled();

    const second = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });
    expect(second!.cacheStatus).toBe("miss");
    expect(mockSynthesizePrep).toHaveBeenCalledTimes(1);
    expect(first!.sourceHash).not.toBe(second!.sourceHash);
  });

  test("synthesis failure returns synthesis_unavailable + raw sources", async () => {
    mockFetchMeetingSources.mockResolvedValue(sourcesWith(VERSION_MARKERS_A));
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    mockSynthesizePrep.mockResolvedValue({
      ok: false,
      code: "invalid_json",
      message: "bad output",
    });
    const result = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });
    expect(result).not.toBeNull();
    expect(result!.synthesisUnavailable).toBe(true);
    expect(result!.prep).toBeNull();
    expect(result!.sources).toBeDefined();
    expect(
      mockTrackEvent.mock.calls.some(
        (c: unknown[]) => c[0] === "assistant.meeting_prep_synthesis_failed",
      ),
    ).toBe(true);
  });

  test("workspace isolation: query is workspace-scoped", async () => {
    mockFetchMeetingSources.mockResolvedValue(sourcesWith(VERSION_MARKERS_A));
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    mockSynthesizePrep.mockResolvedValue({
      ok: true,
      prep: PREP_PAYLOAD,
      latencyMs: 1,
      modelUsed: "x",
      inputTokens: 1,
      outputTokens: 1,
    });
    await prepareMeeting("evt-1", { workspaceId: "ws-b", userId: "u1" });
    /* Every SELECT/INSERT against instinct_meeting_insights passes
       workspace_id as the first param. */
    const insightCalls = mockSafeQuery.mock.calls.filter((c: unknown[]) =>
      /instinct_meeting_insights/.test(c[0] as string),
    );
    expect(insightCalls.length).toBeGreaterThan(0);
    for (const call of insightCalls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe("ws-b");
    }
  });

  test("force=true invalidates active rows and triggers regenerate path", async () => {
    mockFetchMeetingSources.mockResolvedValue(sourcesWith(VERSION_MARKERS_A));
    let updateInvalidationCount = 0;
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/UPDATE instinct_meeting_insights[\s\S]+SET invalidated_at/.test(sql)) {
        updateInvalidationCount += 1;
        return { rows: [], fromCache: false };
      }
      if (/INSERT INTO instinct_meeting_insights/i.test(sql)) {
        return {
          rows: [{ id: "row-1", generated_at: "2026-05-19T00:00:00Z" }],
          fromCache: false,
        };
      }
      return { rows: [], fromCache: false };
    });
    mockSynthesizePrep.mockResolvedValue({
      ok: true,
      prep: PREP_PAYLOAD,
      latencyMs: 1,
      modelUsed: "x",
      inputTokens: 1,
      outputTokens: 1,
    });
    const result = await prepareMeeting("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
      userRole: "cto",
      force: true,
    });
    expect(updateInvalidationCount).toBe(1);
    expect(result!.cacheStatus).toBe("regenerated");
    expect(
      mockTrackEvent.mock.calls.some(
        (c: unknown[]) => c[0] === "assistant.meeting_prep_regenerated",
      ),
    ).toBe(true);
  });
});
