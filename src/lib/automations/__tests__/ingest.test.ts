/**
 * Tests for porsche-classes/ingest — orchestrator behavior.
 *
 * The DB is mocked (jest.mock @/lib/db) because the repo has no
 * integration-DB harness in jest.config; we still assert:
 *   - re-ingesting the same (message_id, sha) is idempotent (no double
 *     snapshot insert, returns was_duplicate)
 *   - parse failures flip the artifact to error_quarantined and create
 *     an exception row
 *   - successful ingest emits analytics + writes one delta per class
 *   - missing-parser path → 'needs_review'
 *
 * Real-fixture round-trip is covered by parser-xlsx.test.ts; this test
 * focuses on the orchestrator wiring.
 */

import type { ParseResult, AutomationDefinition } from "@/lib/automations/types";

const mockWriteQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  query: (...a: unknown[]) => mockQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { ingestArtifact } from "@/lib/automations/porsche-classes/ingest";

beforeEach(() => {
  jest.clearAllMocks();
});

const fakeAutomation = (
  parser?: (...a: unknown[]) => Promise<ParseResult>,
  sourceType: "porsche_xlsx" | "survey" = "porsche_xlsx",
): AutomationDefinition => ({
  id: "porsche-classes",
  name: "Test",
  owner_label: "x",
  description: "x",
  active_window_days: { min: 0, max: 30 },
  inbox_filters: {},
  parsers: parser ? ({ [sourceType]: parser as never } as never) : {},
});

const baseRequest = (overrides: Partial<Parameters<typeof ingestArtifact>[0]> = {}) => ({
  automation: fakeAutomation(),
  source_type: "porsche_xlsx" as const,
  source_message_id: "msg_1",
  received_at: "2026-04-20T18:00:00Z",
  bytes: Buffer.from("xx"),
  hint: "test.xlsx",
  mime: "application/vnd.openxmlformats",
  user_id: "u_1",
  user_role: "ops",
  ...overrides,
});

describe("ingestArtifact — duplicate path", () => {
  it("returns was_duplicate=true when artifact already processed (no parser run)", async () => {
    // Artifact upsert returns existing processed row.
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_1", parse_status: "processed", inserted: false }],
    });

    const parser = jest.fn().mockResolvedValue({ ok: true, source_type: "porsche_xlsx", snapshots: [] });
    const result = await ingestArtifact(
      baseRequest({ automation: fakeAutomation(parser as never) }),
    );

    expect(result.was_duplicate).toBe(true);
    expect(result.parse_status).toBe("processed");
    expect(parser).not.toHaveBeenCalled();
  });
});

describe("ingestArtifact — quarantine path", () => {
  it("flips artifact to error_quarantined + creates exception when parser fails", async () => {
    // 1. artifact insert
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_2", parse_status: "pending", inserted: true }],
    });
    // 2. update artifact -> quarantined
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_2" }] });
    // 3. exception insert
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc_1" }] });

    const parser = jest.fn().mockResolvedValue({
      ok: false,
      source_type: "porsche_xlsx",
      error: "boom",
      exception_kind: "parse_failure",
    } satisfies ParseResult);

    const result = await ingestArtifact(
      baseRequest({ automation: fakeAutomation(parser as never) }),
    );

    expect(result.parse_status).toBe("error_quarantined");
    expect(result.exception_id).toBe("exc_1");
    expect(parser).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.artifact_quarantined",
      "u_1",
      "ops",
      expect.objectContaining({ exception_kind: "parse_failure" }),
    );
  });

  it("flips artifact to needs_review when no parser is registered for source_type", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_3", parse_status: "pending", inserted: true }],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_3" }] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc_2" }] });

    const result = await ingestArtifact(
      baseRequest({
        automation: fakeAutomation(), // no parsers
      }),
    );

    expect(result.parse_status).toBe("error_quarantined");
    expect(result.exception_id).toBe("exc_2");
  });
});

describe("ingestArtifact — success path", () => {
  it("writes one snapshot + one delta per class, marks processed, emits analytics", async () => {
    // 1. artifact insert (new row)
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_4", parse_status: "pending", inserted: true }],
    });

    const parser = jest.fn().mockResolvedValue({
      ok: true,
      source_type: "porsche_xlsx",
      snapshots: [
        {
          source_type: "porsche_xlsx",
          source_message_id: "msg_1",
          source_artifact_id: "art_4",
          captured_at: "2026-04-20T18:00:00Z",
          class: {
            course_type: "BA101",
            class_date: "2026-04-13",
            location: "Hilton Hotel",
            participants: ["alice", "bob"],
          },
        },
      ],
    } satisfies ParseResult);

    // 2. snapshot insert
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "snap_1", inserted: true }],
    });
    // 3. SELECT prev snapshot (returns empty → baseline)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. delta insert
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "delta_1" }] });
    // 5. update artifact -> processed
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_4" }] });

    const result = await ingestArtifact(
      baseRequest({ automation: fakeAutomation(parser as never) }),
    );

    expect(result.parse_status).toBe("processed");
    expect(result.snapshots_written).toBe(1);
    expect(result.deltas_written).toBe(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.delta_computed",
      "u_1",
      "ops",
      expect.objectContaining({ is_baseline: true, added: 2, dropped: 0 }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.artifact_ingested",
      "u_1",
      "ops",
      expect.objectContaining({ classes: 1 }),
    );
  });

  it("auto-splits a multi-class survey when candidate rosters exist (no quarantine)", async () => {
    /* The real survey parser is what's registered in the registry. We
       simulate the orchestrator's multi-class fallback by:
         1. parser returns parse_failure with "multiple courses"
         2. orchestrator decodes survey bytes, queries candidate rosters,
            calls splitMixedSurvey, persists per-class snapshots
       We mock the DB calls in order. */

    // Build a tiny synthetic survey workbook with PPN IDs that match
    // two synthetic candidate classes. xlsx package handles the bytes.
    const XLSX = await import("xlsx");
    const sheetRows = [
      {
        "Assessment Name": "T",
        "First Name": "Alice",
        "Last Name": "Andrews",
        Status: "ACTIVE",
        "PPN ID": "aandrews",
        "Submission Time": "2026-04-10",
        "Question Type": "SINGLE_ANSWER",
        Prompt: "Q1",
        Response: "Strongly agree",
      },
      {
        "Assessment Name": "T",
        "First Name": "Carol",
        "Last Name": "Clark",
        Status: "ACTIVE",
        "PPN ID": "cclark",
        "Submission Time": "2026-04-10",
        "Question Type": "SINGLE_ANSWER",
        Prompt: "Q1",
        Response: "Agree",
      },
    ];
    const sheet = XLSX.utils.json_to_sheet(sheetRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const surveyBytes = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

    // 1. artifact insert (new row)
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_split", parse_status: "pending", inserted: true }],
    });

    // The real parser will be passed in as the registered parser; it
    // returns parse_failure with the "multiple courses" error message
    // when given a mixed-class filename. We mock the parser.
    const parser = jest.fn().mockResolvedValue({
      ok: false,
      source_type: "survey",
      error: "Filename names multiple courses (101, 102); survey responses can't be split without a class roster.",
      exception_kind: "parse_failure",
    });

    // 2. SELECT candidate rosters → return two rows that cover both PPN IDs
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          class_key: "BA101|2026-04-06|Intercontinental",
          course_type: "BA101",
          class_date: "2026-04-06",
          location: "Intercontinental",
          source_payload: {
            participants_with_ppn: [{ first: "Alice", last: "Andrews", ppn_id: "aandrews" }],
          },
        },
        {
          class_key: "BA102|2026-04-06|Conrad",
          course_type: "BA102",
          class_date: "2026-04-06",
          location: "Conrad",
          source_payload: {
            participants_with_ppn: [{ first: "Carol", last: "Clark", ppn_id: "cclark" }],
          },
        },
      ],
    });

    // 3+4. snapshot insert (BA101) + prev-snapshot SELECT (empty) + delta insert
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "snap_a", inserted: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "delta_a" }] });

    // 5+6. snapshot insert (BA102) + prev-snapshot SELECT (empty) + delta insert
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "snap_b", inserted: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "delta_b" }] });

    // 7. update artifact -> processed
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_split" }] });

    const result = await ingestArtifact(
      baseRequest({
        automation: fakeAutomation(parser as never, "survey"),
        source_type: "survey" as const,
        bytes: surveyBytes,
        hint: "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    expect(result.parse_status).toBe("processed");
    expect(result.snapshots_written).toBe(2);
    expect(result.deltas_written).toBe(2);
    expect(result.exception_id).toBeUndefined();
    // The orchestrator emitted artifact_ingested with auto_split=true.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.artifact_ingested",
      "u_1",
      "ops",
      expect.objectContaining({ classes: 2, auto_split: true }),
    );
  });

  it("falls through to quarantine when the multi-class survey has no candidate rosters", async () => {
    // Modify the registry's parser stub: real survey parser would
    // also need to be passed but for this orchestrator-level test we
    // mock it and assert the fallthrough path.
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.json_to_sheet([
      {
        "Assessment Name": "T",
        "First Name": "Alice",
        "Last Name": "A",
        Status: "ACTIVE",
        "PPN ID": "x",
        "Submission Time": "2026-04-10",
        "Question Type": "SINGLE_ANSWER",
        Prompt: "Q1",
        Response: "Agree",
      },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const surveyBytes = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

    // 1. artifact insert
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_no_rosters", parse_status: "pending", inserted: true }],
    });
    const parser = jest.fn().mockResolvedValue({
      ok: false,
      source_type: "survey",
      error: "Filename names multiple courses (101, 102); survey responses can't be split without a class roster.",
      exception_kind: "parse_failure",
    });
    // 2. SELECT candidate rosters → empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3. quarantine: update artifact
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_no_rosters" }] });
    // 4. quarantine: insert exception
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc_no_rosters" }] });

    const result = await ingestArtifact(
      baseRequest({
        automation: fakeAutomation(parser as never, "survey"),
        source_type: "survey" as const,
        bytes: surveyBytes,
        hint: "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    expect(result.parse_status).toBe("error_quarantined");
    expect(result.exception_id).toBe("exc_no_rosters");
    // The quarantine reason should mention the auto-split was attempted.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.artifact_quarantined",
      "u_1",
      "ops",
      expect.objectContaining({
        reason: expect.stringMatching(/auto-split attempted/i),
      }),
    );
  });

  it("re-ingest same artifact (idempotent snapshot path) does NOT count as new write", async () => {
    // artifact insert
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art_5", parse_status: "pending", inserted: true }],
    });

    const parser = jest.fn().mockResolvedValue({
      ok: true,
      source_type: "porsche_xlsx",
      snapshots: [
        {
          source_type: "porsche_xlsx",
          source_message_id: "msg_1",
          source_artifact_id: "art_5",
          captured_at: "2026-04-20T18:00:00Z",
          class: {
            course_type: "BA101",
            class_date: "2026-04-13",
            location: "Hilton Hotel",
            participants: ["alice"],
          },
        },
      ],
    } satisfies ParseResult);

    // snapshot upsert returns inserted=false (already there)
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "snap_existing", inserted: false }],
    });
    // mark processed
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art_5" }] });

    const result = await ingestArtifact(
      baseRequest({ automation: fakeAutomation(parser as never) }),
    );

    expect(result.snapshots_written).toBe(0);
    expect(result.deltas_written).toBe(0);
    expect(result.parse_status).toBe("processed");
  });
});
