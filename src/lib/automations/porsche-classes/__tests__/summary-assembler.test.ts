/**
 * Summary assembler — unit tests against an injected QueryRunner.
 *
 * We don't spin up Postgres. The assembler exposes a `query` option for
 * exactly this reason: pass a fake that returns canned rows and assert
 * the projection. Stream A's E2E will exercise the real DB path; this
 * suite is a fast pure-function verification of the projection logic.
 */

import {
  assemblePorscheClassSummary,
  type QueryRunner,
} from "../summary-assembler";

interface FakeRows {
  snapshots: Record<string, unknown>[];
  exceptions: Record<string, unknown>[];
}

function fakeQuery(rows: FakeRows): QueryRunner {
  return (async <T extends Record<string, unknown>>(text: string) => {
    if (/instinct_automation_porsche_snapshots/.test(text) && /DISTINCT ON/.test(text)) {
      return { rows: rows.snapshots as T[] };
    }
    if (/instinct_automation_porsche_exceptions/.test(text)) {
      return { rows: rows.exceptions as T[] };
    }
    return { rows: [] as T[] };
  }) as QueryRunner;
}

const NOW = "2026-04-21T15:00:00.000Z";

describe("assemblePorscheClassSummary", () => {
  it("returns null when there are no snapshots", async () => {
    const result = await assemblePorscheClassSummary(
      "BA101|2026-04-13|Westlake",
      {
        query: fakeQuery({ snapshots: [], exceptions: [] }),
        now: () => NOW,
      },
    );
    expect(result).toBeNull();
  });

  it("rolls up coordinator + instructor + xlsx into the contract shape", async () => {
    const result = await assemblePorscheClassSummary(
      "BA101|2026-04-13|Westlake",
      {
        query: fakeQuery({
          snapshots: [
            {
              id: "1",
              source_type: "porsche_xlsx",
              source_message_id: null,
              source_artifact_id: "artifact-xlsx-1",
              captured_at: "2026-04-19T08:00:00.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: ["alice smith", "bob jones", "carla lee"],
              source_payload: {},
              participant_hash: "hash-xlsx",
              created_at: "2026-04-19T08:00:00.000Z",
            },
            {
              id: "2",
              source_type: "cognito_coordinator",
              source_message_id: "msg-coord-1",
              source_artifact_id: "artifact-coord-1",
              captured_at: "2026-04-20T21:24:31.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: [],
              source_payload: {
                coordinator_name: "Amy Federman",
                coordinator_email: "amy@porscheacademy.us",
                participant_count: 29,
                fields: {},
                sections: [
                  {
                    heading: "Entry Details",
                    fields: [
                      { label: "Name", value: "Amy Federman" },
                      { label: "Class", value: "BA101" },
                    ],
                  },
                  {
                    heading: "Hotel Experience",
                    fields: [
                      {
                        label: "Overall Hotel Experience",
                        value: "Excellent! Recommended to move Asia lunch.",
                      },
                    ],
                  },
                ],
              },
              participant_hash: "hash-coord",
              created_at: "2026-04-20T21:24:31.000Z",
            },
            {
              id: "3",
              source_type: "cognito_instructor",
              source_message_id: "msg-inst-1",
              source_artifact_id: "artifact-inst-1",
              captured_at: "2026-04-19T18:00:00.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: [],
              source_payload: {
                instructor_name: "Jen Eby",
                instructor_email: "jen@porscheacademy.us",
                fields: {},
                sections: [
                  {
                    heading: "Entry Details",
                    fields: [
                      {
                        label: "Please provide details:",
                        value: "Deleted entries for Smart Goals & SWOT",
                      },
                    ],
                  },
                ],
              },
              participant_hash: "hash-inst",
              created_at: "2026-04-19T18:00:00.000Z",
            },
          ],
          exceptions: [],
        }),
        now: () => NOW,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.class_key).toBe("BA101|2026-04-13|Westlake");
    expect(result!.course_type).toBe("BA101");
    expect(result!.class_date).toBe("2026-04-13");
    expect(result!.location).toBe("Westlake");

    // xlsx provides participants
    expect(result!.participants).toEqual([
      "alice smith",
      "bob jones",
      "carla lee",
    ]);

    // coordinator notes — one per author, with hotel-experience text in the note
    expect(result!.coordinator_notes).toEqual([
      {
        author: "Amy Federman",
        note: expect.stringContaining("Overall Hotel Experience"),
      },
    ]);

    // instructor notes — one per author
    expect(result!.instructor_notes).toEqual([
      {
        author: "Jen Eby",
        note: expect.stringContaining("Please provide details:"),
      },
    ]);

    // survey null until parser-survey is real
    expect(result!.survey).toBeNull();

    // open exceptions empty
    expect(result!.open_exceptions).toEqual([]);

    // sources counts
    expect(result!.sources).toEqual({
      porsche_xlsx: 1,
      cognito_coordinator: 1,
      cognito_instructor: 1,
      survey: 0,
    });

    expect(result!.generated_at).toBe(NOW);
  });

  it("falls back to a non-xlsx snapshot for participants when xlsx absent", async () => {
    const result = await assemblePorscheClassSummary(
      "BA101|2026-04-13|Westlake",
      {
        query: fakeQuery({
          snapshots: [
            {
              id: "2",
              source_type: "cognito_coordinator",
              source_message_id: null,
              source_artifact_id: "artifact-coord-2",
              captured_at: "2026-04-20T21:24:31.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: [],
              source_payload: {
                coordinator_name: "Amy Federman",
                fields: {},
                sections: [],
              },
              participant_hash: "h",
              created_at: "x",
            },
          ],
          exceptions: [],
        }),
        now: () => NOW,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.participants).toEqual([]);
  });

  it("surfaces open exceptions touching this class", async () => {
    const result = await assemblePorscheClassSummary(
      "BA101|2026-04-13|Westlake",
      {
        query: fakeQuery({
          snapshots: [
            {
              id: "1",
              source_type: "porsche_xlsx",
              source_message_id: null,
              source_artifact_id: "artifact-xlsx-1",
              captured_at: "2026-04-19T08:00:00.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: ["alice"],
              source_payload: {},
              participant_hash: "h",
              created_at: "x",
            },
          ],
          exceptions: [
            {
              id: "exc-1",
              automation_id: "porsche-classes",
              artifact_id: "artifact-survey-1",
              kind: "parse_failure",
              detail: "Survey format not yet specified",
              status: "open",
              resolved_by: null,
              resolved_at: null,
              created_at: "2026-04-21T10:00:00.000Z",
            },
          ],
        }),
        now: () => NOW,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.open_exceptions).toHaveLength(1);
    expect(result!.open_exceptions[0].kind).toBe("parse_failure");
    expect(result!.open_exceptions[0].automation_id).toBe("porsche-classes");
  });

  it("uses the latest snapshot per source_type (DISTINCT ON contract)", async () => {
    // The fake assumes the SQL already filtered to the latest row per
    // source_type. The DISTINCT ON clause in the real SQL handles that;
    // here we just verify the assembler doesn't accidentally
    // double-count when a single source_type happens to be present.
    const result = await assemblePorscheClassSummary(
      "BA101|2026-04-13|Westlake",
      {
        query: fakeQuery({
          snapshots: [
            {
              id: "newer",
              source_type: "cognito_coordinator",
              source_message_id: null,
              source_artifact_id: "artifact-coord-newer",
              captured_at: "2026-04-22T00:00:00.000Z",
              class_key: "BA101|2026-04-13|Westlake",
              course_type: "BA101",
              class_date: "2026-04-13",
              location: "Westlake",
              participants: [],
              source_payload: {
                coordinator_name: "Amy Federman",
                fields: {},
                sections: [],
              },
              participant_hash: "h",
              created_at: "x",
            },
          ],
          exceptions: [],
        }),
        now: () => NOW,
      },
    );
    expect(result!.sources.cognito_coordinator).toBe(1);
    expect(result!.coordinator_notes).toHaveLength(1);
  });
});
