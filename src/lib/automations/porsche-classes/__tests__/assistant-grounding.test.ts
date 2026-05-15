/**
 * Tests for the porsche-classes assistant grounding source.
 *
 * Covers:
 *   - Trigger gate (keyword regex) — fires on class-related questions,
 *     no-op on unrelated ones.
 *   - SQL parameter shape — class_date filtered when a date range is
 *     supplied, course filtered when BA101 / BA102 is named.
 *   - Snippet formatting — participants + latest delta render compactly
 *     so the LLM gets the "what changed" signal inline.
 *   - Failure mode — DB error returns a typed result, not a throw.
 *   - Shadow mode — no DATABASE_URL returns ok with empty hits so the
 *     assistant keeps working without a DB.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

import {
  searchPorscheClassNotes,
  questionTouchesPorscheClasses,
  trackPorscheClassLookupFailure,
} from "../assistant-grounding";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("questionTouchesPorscheClasses", () => {
  test.each([
    "what classes ran last Friday",
    "BA101 attendance this week",
    "how many participants in ba102",
    "what changed in the porsche class on Monday",
    "who was the instructor for BA101",
  ])("matches '%s'", (q) => {
    expect(questionTouchesPorscheClasses(q)).toBe(true);
  });

  test.each([
    "what's on my calendar today",
    "draft an email to Hoxsie",
    "what is quantum computing",
    "hi",
  ])("does NOT match '%s'", (q) => {
    expect(questionTouchesPorscheClasses(q)).toBe(false);
  });
});

describe("searchPorscheClassNotes — trigger gate", () => {
  test("returns empty hits and skips SQL when question is unrelated", async () => {
    const r = await searchPorscheClassNotes({ question: "draft an email to Hoxsie" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("returns 400-code result on empty question", async () => {
    const r = await searchPorscheClassNotes({ question: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_query");
  });
});

describe("searchPorscheClassNotes — shadow mode", () => {
  test("no DATABASE_URL returns ok with empty hits (no SQL attempted)", async () => {
    delete process.env.DATABASE_URL;
    const r = await searchPorscheClassNotes({ question: "BA101 last Friday" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("searchPorscheClassNotes — happy path", () => {
  test("maps rows to MeetingNoteHit shape with participant snippet + latest delta", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "snap-1",
          course_type: "BA101",
          class_date: "2026-04-20",
          location: "Atlanta",
          participants: ["Alice", "Bob", "Carol"],
          captured_at: "2026-04-20T15:00:00Z",
          class_key: "BA101|2026-04-20|Atlanta",
          added: ["Carol"],
          dropped: [],
          net_change: 1,
          delta_at: "2026-04-20T15:00:00Z",
        },
      ],
      fromCache: false,
    });

    const r = await searchPorscheClassNotes({ question: "what changed in BA101 this week" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits).toHaveLength(1);
    const hit = r.hits[0];
    expect(hit.title).toBe("BA101 2026-04-20 Atlanta");
    expect(hit.source_kind).toBe("porsche_class");
    expect(hit.url).toBe("/automations/porsche-classes");
    expect(hit.snippet).toContain("3 participants");
    expect(hit.snippet).toContain("Alice");
    expect(hit.snippet).toContain("+1 added (Carol)");
  });

  test("course-name terms (BA101 / BA102) become SQL params for course filter", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    await searchPorscheClassNotes({ question: "how many were in BA102 last Friday" });
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const sql = (mockSafeQuery.mock.calls[0][0] as string).replace(/\s+/g, " ");
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("s.course_type = $");
    expect(params).toContain("BA102");
  });

  test("date range adds class_date BETWEEN filter", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    await searchPorscheClassNotes({
      question: "BA101 class on April 20, 2026",
      dateRange: { startISO: "2026-04-20T00:00:00Z", endISO: "2026-04-20T23:59:59Z" },
    });

    const sql = (mockSafeQuery.mock.calls[0][0] as string).replace(/\s+/g, " ");
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("s.class_date BETWEEN");
    expect(params).toContain("2026-04-20");
  });

  test("snippet handles dropped participants too", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "snap-2",
          course_type: "BA101",
          class_date: "2026-04-22",
          location: "Atlanta",
          participants: ["Alice"],
          captured_at: "2026-04-22T15:00:00Z",
          class_key: "BA101|2026-04-22|Atlanta",
          added: [],
          dropped: ["Bob", "Carol"],
          net_change: -2,
          delta_at: "2026-04-22T15:00:00Z",
        },
      ],
      fromCache: false,
    });

    const r = await searchPorscheClassNotes({ question: "porsche class attendance" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits[0].snippet).toContain("-2 dropped (Bob, Carol)");
  });

  test("handles JSON-string participants from older snapshots", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "snap-3",
          course_type: "BA102",
          class_date: "2026-04-23",
          location: "Charlotte",
          participants: '["Alice","Bob"]',
          captured_at: "2026-04-23T15:00:00Z",
          class_key: "BA102|2026-04-23|Charlotte",
          added: "[]",
          dropped: "[]",
          net_change: 0,
          delta_at: null,
        },
      ],
      fromCache: false,
    });

    const r = await searchPorscheClassNotes({ question: "BA102 in Charlotte" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits[0].snippet).toContain("2 participants");
    expect(r.hits[0].snippet).toContain("Alice, Bob");
  });
});

describe("searchPorscheClassNotes — failure modes", () => {
  test("safeQuery throw returns typed internal error", async () => {
    mockSafeQuery.mockRejectedValue(new Error("connection refused"));
    const r = await searchPorscheClassNotes({ question: "BA101 attendance" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("internal");
      expect(r.status).toBe(500);
      expect(r.message).toContain("connection refused");
    }
  });

  test("safeQuery fromCache=true is treated as shadow mode", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    const r = await searchPorscheClassNotes({ question: "BA101 attendance" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits).toEqual([]);
  });
});

describe("trackPorscheClassLookupFailure", () => {
  test("fires the typed analytics event with status + code", () => {
    trackPorscheClassLookupFailure("u-1", "cto", {
      ok: false,
      status: 500,
      code: "internal",
      message: "boom",
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.porsche_class_lookup_failed",
      "u-1",
      "cto",
      expect.objectContaining({ status: 500, code: "internal" }),
    );
  });
});
