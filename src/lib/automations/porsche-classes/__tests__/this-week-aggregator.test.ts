/**
 * this-week-aggregator — unit tests against an injected QueryRunner.
 *
 * Mirrors the FakeQueryRunner pattern from summary-assembler.test.ts:
 * we route SQL fragments to canned row arrays based on substring match
 * so the aggregator runs end-to-end with no Postgres dependency.
 *
 * Each SQL fragment owns a unique substring:
 *   instinct_automation_porsche_snapshots → snapshots fixture
 *   instinct_automation_porsche_exceptions → exceptions fixture
 *   instinct_automation_porsche_overrides  → merge (class_match) fixture
 *   instinct_events                        → uploads fixture
 */

import {
  listThisWeekClasses,
  projectThisWeekRows,
  EXPECTED_SOURCES,
} from "../this-week-aggregator";
import type { QueryRunner } from "../summary-assembler";

interface FakeRows {
  snapshots?: Record<string, unknown>[];
  exceptions?: Record<string, unknown>[];
  merges?: Record<string, unknown>[];
  uploads?: Record<string, unknown>[];
}

function fakeQuery(rows: FakeRows): QueryRunner {
  return (async <T extends Record<string, unknown>>(text: string) => {
    if (/instinct_events/.test(text)) {
      return { rows: (rows.uploads ?? []) as T[] };
    }
    if (/instinct_automation_porsche_overrides/.test(text)) {
      return { rows: (rows.merges ?? []) as T[] };
    }
    if (/instinct_automation_porsche_exceptions/.test(text)) {
      return { rows: (rows.exceptions ?? []) as T[] };
    }
    if (/instinct_automation_porsche_snapshots/.test(text)) {
      return { rows: (rows.snapshots ?? []) as T[] };
    }
    return { rows: [] as T[] };
  }) as QueryRunner;
}

const NOW = new Date("2026-04-25T12:00:00.000Z");
const ARGS = {
  automationId: "porsche-classes" as const,
  windowMinDays: -7,
  windowMaxDays: 60,
};

describe("EXPECTED_SOURCES", () => {
  it("locks the four-source contract used by status math", () => {
    expect(EXPECTED_SOURCES).toEqual([
      "porsche_xlsx",
      "cognito_coordinator",
      "cognito_instructor",
      "survey",
    ]);
  });
});

describe("listThisWeekClasses", () => {
  it("returns [] when no snapshots fall in the window", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({}),
      now: () => NOW,
    });
    expect(result).toEqual([]);
  });

  it("ready: all 4 sources present, no exceptions, never uploaded", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_coordinator",
            captured_at: "2026-04-24T09:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_instructor",
            captured_at: "2026-04-24T10:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "survey",
            captured_at: "2026-04-24T11:00:00.000Z",
          }),
        ],
      }),
      now: () => NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      class_key: "BA101|2026-04-30|Westlake",
      status: "ready",
      sources_missing: [],
      sources_present: [
        "porsche_xlsx",
        "cognito_coordinator",
        "cognito_instructor",
        "survey",
      ],
      sharepoint_uploaded_at: null,
      open_exception_count: 0,
      last_activity_at: "2026-04-24T11:00:00.000Z",
    });
    expect(result[0].attention_reason).toBeUndefined();
  });

  it("waiting: at least one expected source missing, no issues", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA102|2026-05-01|Atlanta",
            source_type: "porsche_xlsx",
            class_date: "2026-05-01",
            location: "Atlanta",
            course_type: "BA102",
            captured_at: "2026-04-23T12:00:00.000Z",
          }),
        ],
      }),
      now: () => NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("waiting");
    expect(result[0].sources_present).toEqual(["porsche_xlsx"]);
    expect(result[0].sources_missing).toEqual([
      "cognito_coordinator",
      "cognito_instructor",
      "survey",
    ]);
    expect(result[0].open_exception_count).toBe(0);
  });

  it("needs_attention: open exception touches the class via artifact join", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-04-30|Boston",
            location: "Boston",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T09:00:00.000Z",
          }),
        ],
        exceptions: [
          { class_key: "BA101|2026-04-30|Boston", exception_id: "e1" },
        ],
      }),
      now: () => NOW,
    });
    expect(result[0].status).toBe("needs_attention");
    expect(result[0].open_exception_count).toBe(1);
    expect(result[0].attention_reason).toMatch(/1 open issue/i);
  });

  it("needs_attention: latest survey snapshot has unmatched_respondents", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_coordinator",
            captured_at: "2026-04-24T09:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_instructor",
            captured_at: "2026-04-24T10:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "survey",
            captured_at: "2026-04-24T11:00:00.000Z",
            source_payload: {
              survey: { response_count: 3, average_score: 4.2, questions: [] },
              unmatched_respondents: [
                { first: "X", last: "Y", ppn_id: null },
                { first: "A", last: "B", ppn_id: "999" },
              ],
            },
          }),
        ],
      }),
      now: () => NOW,
    });
    expect(result[0].status).toBe("needs_attention");
    expect(result[0].sources_missing).toEqual([]);
    expect(result[0].attention_reason).toMatch(
      /2 survey respondents didn't match the roster/i,
    );
  });

  it("populates sharepoint_uploaded_at when the event log has a successful upload", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_coordinator",
            captured_at: "2026-04-24T09:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "cognito_instructor",
            captured_at: "2026-04-24T10:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            source_type: "survey",
            captured_at: "2026-04-24T11:00:00.000Z",
          }),
        ],
        uploads: [
          {
            class_key: "BA101|2026-04-30|Westlake",
            uploaded_at: "2026-04-24T12:30:00.000Z",
          },
        ],
      }),
      now: () => NOW,
    });
    expect(result[0].sharepoint_uploaded_at).toBe("2026-04-24T12:30:00.000Z");
    /* Status should still be "ready" — already-uploaded doesn't change
       the status; the page hides the "Send to SharePoint" button when
       sharepoint_uploaded_at is non-null. */
    expect(result[0].status).toBe("ready");
  });

  it("merges class_match-equivalent class_keys into one canonical row", async () => {
    /* Survey came in under the wrong key; coordinator under the right
       one. After class_match, both should fold into a single ready row. */
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-04-30|Atlanta",
            location: "Atlanta",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Atlanta",
            location: "Atlanta",
            source_type: "cognito_coordinator",
            captured_at: "2026-04-24T09:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Atlanta",
            location: "Atlanta",
            source_type: "cognito_instructor",
            captured_at: "2026-04-24T10:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Intercontinental",
            location: "Intercontinental",
            source_type: "survey",
            captured_at: "2026-04-24T11:00:00.000Z",
          }),
        ],
        merges: [
          {
            from_value: "BA101|2026-04-30|Intercontinental",
            to_value: "BA101|2026-04-30|Atlanta",
          },
        ],
      }),
      now: () => NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0].sources_present).toEqual([
      "porsche_xlsx",
      "cognito_coordinator",
      "cognito_instructor",
      "survey",
    ]);
    expect(result[0].status).toBe("ready");
  });

  it("sorts by class_date ascending", async () => {
    const result = await listThisWeekClasses(ARGS, {
      query: fakeQuery({
        snapshots: [
          mkSnap({
            class_key: "BA101|2026-05-15|Boston",
            class_date: "2026-05-15",
            location: "Boston",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-04-30|Westlake",
            class_date: "2026-04-30",
            location: "Westlake",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
          mkSnap({
            class_key: "BA101|2026-05-01|Atlanta",
            class_date: "2026-05-01",
            location: "Atlanta",
            source_type: "porsche_xlsx",
            captured_at: "2026-04-24T08:00:00.000Z",
          }),
        ],
      }),
      now: () => NOW,
    });
    expect(result.map((r) => r.class_date)).toEqual([
      "2026-04-30",
      "2026-05-01",
      "2026-05-15",
    ]);
  });
});

describe("projectThisWeekRows (pure)", () => {
  it("does not flag a class as needs_attention when an exception lacks a class link", () => {
    const rows = projectThisWeekRows({
      snapshots: [
        mkSnap({
          class_key: "BA101|2026-04-30|Westlake",
          source_type: "porsche_xlsx",
          captured_at: "2026-04-24T08:00:00.000Z",
        }) as never,
      ],
      exceptions: [
        // No class_key — orphan exception (artifact never resolved to a snapshot).
        { class_key: null, exception_id: "e1" },
      ],
      merges: [],
      uploads: [],
    });
    expect(rows[0].open_exception_count).toBe(0);
    expect(rows[0].status).toBe("waiting");
  });
});

/* ------------------------------------------------------------------ */
/* Snapshot fixture factory                                            */
/* ------------------------------------------------------------------ */

interface SnapOverrides {
  class_key: string;
  source_type: string;
  course_type?: string;
  class_date?: string;
  location?: string;
  captured_at: string;
  participants?: string[];
  source_payload?: Record<string, unknown> | null;
}

function mkSnap(o: SnapOverrides): Record<string, unknown> {
  return {
    class_key: o.class_key,
    source_type: o.source_type,
    course_type: o.course_type ?? "BA101",
    class_date: o.class_date ?? "2026-04-30",
    location: o.location ?? "Westlake",
    captured_at: o.captured_at,
    participants: o.participants ?? [],
    source_payload: o.source_payload ?? {},
  };
}
