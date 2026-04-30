/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import {
  extractExplicitDate,
  runMeetingsOnDate,
} from "@/lib/assistant/tools/meetings-on-date";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("extractExplicitDate", () => {
  test("parses 'April 21, 2026'", () => {
    const r = extractExplicitDate("which meetings on April 21, 2026 ?");
    expect(r).not.toBeNull();
    expect(new Date(r!.startMs).toISOString().slice(0, 10)).toBe("2026-04-21");
  });

  test("parses ISO 2026-04-21", () => {
    const r = extractExplicitDate("meetings 2026-04-21");
    expect(r?.startMs).toBe(Date.UTC(2026, 3, 21));
  });

  test("parses 4/21/2026", () => {
    const r = extractExplicitDate("meetings on 4/21/2026");
    expect(r?.startMs).toBe(Date.UTC(2026, 3, 21));
  });

  test("returns null when no date present", () => {
    expect(extractExplicitDate("which meetings did wolfpack have")).toBeNull();
  });
});

describe("runMeetingsOnDate", () => {
  test("returns null without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const r = await runMeetingsOnDate({
      question: "meetings on April 21, 2026",
    });
    expect(r).toBeNull();
  });

  test("returns null when no date in question", async () => {
    const r = await runMeetingsOnDate({ question: "what is wolfpack" });
    expect(r).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("formats answer with the matched meetings", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "m1",
          title: "PCBA_E4_Content Weekly Status Call",
          summary: null,
          recorded_at: "2026-04-21T19:30:00Z",
          duration_seconds: 4500,
          owner_name: "Jorge Colon",
        },
      ],
    });
    const r = await runMeetingsOnDate({
      question: "which meetings did wolfpack have on April 21, 2026 ?",
    });
    expect(r).not.toBeNull();
    expect(r!.meetings).toHaveLength(1);
    expect(r!.answer).toContain("PCBA_E4_Content Weekly Status Call");
    expect(r!.answer).toContain("Jorge Colon");
    expect(r!.answer).toContain("[Meetings](/meetings)");
  });

  test("returns 'No meetings recorded' when DB has none", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const r = await runMeetingsOnDate({
      question: "meetings on 2026-04-21",
    });
    expect(r?.meetings).toEqual([]);
    expect(r?.answer).toMatch(/No meetings recorded/);
  });
});
