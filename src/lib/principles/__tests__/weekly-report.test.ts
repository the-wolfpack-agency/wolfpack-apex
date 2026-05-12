 
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
    writeQuery: (...a: any[]) => mockWriteQuery(...a),
  };
});

import {
  buildWeeklyReportMarkdown,
  upsertWeeklyReport,
  getLatestWeeklyReport,
} from "@/lib/principles/weekly-report";
import type { PrincipleRecord, ObservationRecord } from "@/lib/principles/store";
import type { UserNameRecord } from "@/lib/principles/user-names";

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
});

const principle = (over: Partial<PrincipleRecord> = {}): PrincipleRecord => ({
  id: "p1",
  slug: "ship-before-perfect",
  title: "Ship before perfect",
  domains: ["code"],
  owner: "Hoxsie",
  bodyMd: "",
  scoreboardWeight: 3,
  sourceUrl: null,
  sourceDocHash: null,
  effectiveAt: null,
  retiredAt: null,
  createdAt: "2026-05-01",
  updatedAt: "2026-05-01",
  ...over,
});

const obs = (over: Partial<ObservationRecord>): ObservationRecord => ({
  id: "o1",
  principleId: "p1",
  signalId: null,
  validatorId: "v",
  surface: "mail",
  surfaceSubtype: "outlook_send_after_hours",
  subjectUserId: "u-alicia",
  observedAt: "2026-05-04T03:00:00Z",
  score: -0.6,
  evidenceJsonb: { kind: "x" },
  ...over,
});

const names = (): Map<string, UserNameRecord> =>
  new Map([
    [
      "u-alicia",
      { userId: "u-alicia", displayName: "Alicia Zulker", email: "a@x" },
    ],
    [
      "u-self",
      { userId: "u-self", displayName: "Nick Homyk", email: "n@x" },
    ],
  ]);

describe("buildWeeklyReportMarkdown", () => {
  test("zero principles → friendly empty-state copy", () => {
    const md = buildWeeklyReportMarkdown({
      weekStart: new Date("2026-04-28T00:00:00Z"),
      weekEnd: new Date("2026-05-05T00:00:00Z"),
      principles: [],
      observations: [],
      names: new Map(),
    });
    expect(md).toContain("Wolfpack — Principles Last Week");
    expect(md).toMatch(/No principles defined yet/);
  });

  test("principle with no observations gets the 'no observations' callout", () => {
    const md = buildWeeklyReportMarkdown({
      weekStart: new Date("2026-04-28T00:00:00Z"),
      weekEnd: new Date("2026-05-05T00:00:00Z"),
      principles: [principle()],
      observations: [],
      names: new Map(),
    });
    expect(md).toContain("Ship before perfect");
    expect(md).toMatch(/No observations this week/);
  });

  test("principle with observations: per-member rollup table + drift sample", () => {
    const md = buildWeeklyReportMarkdown({
      weekStart: new Date("2026-04-28T00:00:00Z"),
      weekEnd: new Date("2026-05-05T00:00:00Z"),
      principles: [principle()],
      observations: [
        obs({ id: "o1", subjectUserId: "u-alicia", score: -0.7 }),
        obs({ id: "o2", subjectUserId: "u-alicia", score: -0.5 }),
        obs({ id: "o3", subjectUserId: "u-self", score: -0.4 }),
        obs({ id: "o4", subjectUserId: "u-self", score: 0.2 }),
      ],
      names: names(),
    });
    /* Table header is present. */
    expect(md).toMatch(/\| Member \| Observations \| Mean score \|/);
    /* Names render, not UUIDs. */
    expect(md).toContain("Alicia Zulker");
    expect(md).toContain("Nick Homyk");
    /* Most-drift first → Alicia (mean -0.6) before Nick (mean -0.1). */
    const idxAlicia = md.indexOf("Alicia Zulker");
    const idxSelf = md.indexOf("Nick Homyk");
    expect(idxAlicia).toBeLessThan(idxSelf);
    /* Drift trending warning fires (overall mean is negative). */
    expect(md).toMatch(/trending toward drift/);
  });

  test("no negative observations: drift warning is suppressed", () => {
    const md = buildWeeklyReportMarkdown({
      weekStart: new Date("2026-04-28T00:00:00Z"),
      weekEnd: new Date("2026-05-05T00:00:00Z"),
      principles: [principle()],
      observations: [
        obs({ id: "o1", subjectUserId: "u-alicia", score: 0.5 }),
        obs({ id: "o2", subjectUserId: "u-self", score: 0.4 }),
      ],
      names: names(),
    });
    expect(md).not.toMatch(/trending toward drift/);
  });
});

describe("upsertWeeklyReport", () => {
  test("INSERT … ON CONFLICT (week_start) DO UPDATE", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "r1",
          week_start: "2026-04-28",
          week_end: "2026-05-05",
          markdown_body: "x",
          observation_count: 3,
          principle_count: 1,
          generated_at: "2026-05-05",
        },
      ],
    });
    const out = await upsertWeeklyReport({
      weekStart: "2026-04-28",
      weekEnd: "2026-05-05",
      markdownBody: "x",
      observationCount: 3,
      principleCount: 1,
    });
    expect(out.weekStart).toBe("2026-04-28");
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(
      /INSERT INTO instinct_principle_weekly_reports[\s\S]+ON CONFLICT \(week_start\)[\s\S]+DO UPDATE/,
    );
  });
});

describe("getLatestWeeklyReport", () => {
  test("returns null when no rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getLatestWeeklyReport()).toBeNull();
  });
  test("maps row to record", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "r1",
          week_start: "2026-04-28",
          week_end: "2026-05-05",
          markdown_body: "# md",
          observation_count: 7,
          principle_count: 3,
          generated_at: "2026-05-05",
        },
      ],
    });
    const out = await getLatestWeeklyReport();
    expect(out?.markdownBody).toBe("# md");
    expect(out?.observationCount).toBe(7);
  });
});
