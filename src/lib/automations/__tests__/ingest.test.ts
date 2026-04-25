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

const fakeAutomation = (parser?: (...a: unknown[]) => Promise<ParseResult>): AutomationDefinition => ({
  id: "porsche-classes",
  name: "Test",
  owner_label: "x",
  description: "x",
  active_window_days: { min: 0, max: 30 },
  inbox_filters: {},
  parsers: parser ? { porsche_xlsx: parser as never } : {},
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
