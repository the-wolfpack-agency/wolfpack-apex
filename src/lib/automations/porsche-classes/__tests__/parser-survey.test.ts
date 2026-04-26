/**
 * Survey parser tests — exercises the real xlsx parser against the
 * three program-eval fixtures Alicia provided.
 *
 * Coverage:
 *   - filename → class identity (single-class, ambiguous-multi-class)
 *   - Likert vocabulary tolerance ("Strongly Agree", "Strong Disagree",
 *     case-insensitive)
 *   - response_count counts unique respondents, not raw rows
 *   - average_score within 1-5
 *   - per-question rollup includes both ratings + open-text comments
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  parseSurvey,
  parseClassIdentityFromFilename,
  parseMultiClassFilename,
  splitMixedSurvey,
  decodeSurveyRows,
  type RawRow,
} from "../parser-survey";

const FIXTURES_DIR = path.join(__dirname, "..", "__fixtures__");

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES_DIR, name));
}

const baseEnvelope = {
  received_at: "2026-04-20T22:00:00.000Z",
  source_message_id: null,
  source_artifact_id: "artifact-test",
};

describe("parseClassIdentityFromFilename", () => {
  it("parses 'Survey Data PCBA 101 Pendry March 23-27th.xlsx'", () => {
    const r = parseClassIdentityFromFilename(
      "Survey Data PCBA 101 Pendry March 23-27th.xlsx",
      2026,
    );
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.course_type).toBe("BA101");
    expect(r.class_date).toBe("2026-03-23");
    expect(r.location).toBe("Pendry");
  });

  it("parses '102 Intercontinental March 16-20, 2026.xlsx'", () => {
    const r = parseClassIdentityFromFilename(
      "102 Intercontinental March 16-20, 2026.xlsx",
      2025,
    );
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.course_type).toBe("BA102");
    expect(r.class_date).toBe("2026-03-16");
    expect(r.location).toBe("Intercontinental");
  });

  it("REFUSES multi-hotel filenames so they route to the splitter (e.g. 'Conrad & Westlake')", () => {
    // Production bug found 2026-04-26: "Survey Data PCBA 101 Conrad &
    // Westlake_April 13-17.xlsx" had 869 rows, 58 respondents, and
    // was being parsed as ONE class with location "Conrad &
    // Westlake". That class doesn't exist in the snapshot store, so
    // every respondent ended up orphaned. Same fix shape as the
    // multi-course refusal: surface a structured error so the
    // orchestrator routes to splitMixedSurvey, which buckets
    // respondents by PPN ID against the Conrad and Westlake rosters.
    const r = parseClassIdentityFromFilename(
      "Survey Data PCBA 101 Conrad & Westlake_April 13-17.xlsx",
      2026,
    );
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toMatch(/multiple locations/i);
  });

  it("REFUSES multi-course filenames (101 AND 102 in one file)", () => {
    const r = parseClassIdentityFromFilename(
      "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
      2026,
    );
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toMatch(/multiple courses/i);
  });
});

describe("parseSurvey · single-class fixtures", () => {
  it("aggregates the Pendry 101 export (1 class, ~32 respondents, all Likert variants)", async () => {
    const result = await parseSurvey({
      bytes: readFixture("survey-real-101-pendry.xlsx"),
      hint: "Survey Data PCBA 101 Pendry March 23-27th.xlsx",
      ...baseEnvelope,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source_type).toBe("survey");
    expect(result.snapshots).toHaveLength(1);
    const s = result.snapshots[0];
    expect(s.class.course_type).toBe("BA101");
    expect(s.class.location).toBe("Pendry");
    const survey = (s.source_payload as { survey: { response_count: number; average_score: number | null; questions: unknown[] } }).survey;
    expect(survey.response_count).toBeGreaterThanOrEqual(20);
    expect(survey.average_score).not.toBeNull();
    expect(survey.average_score!).toBeGreaterThanOrEqual(1);
    expect(survey.average_score!).toBeLessThanOrEqual(5);
    expect(survey.questions.length).toBeGreaterThan(5);
  });

  it("aggregates the 102 Intercontinental export", async () => {
    const result = await parseSurvey({
      bytes: readFixture("survey-real-102-intercontinental.xlsx"),
      hint: "102 Intercontinental March 16-20, 2026.xlsx",
      ...baseEnvelope,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.snapshots[0];
    expect(s.class.course_type).toBe("BA102");
    expect(s.class.class_date).toBe("2026-03-16");
    expect(s.class.location).toBe("Intercontinental");
    const survey = (s.source_payload as { survey: { response_count: number; average_score: number | null } }).survey;
    expect(survey.response_count).toBeGreaterThanOrEqual(10);
    expect(survey.average_score).not.toBeNull();
  });

  it("handles 'Strong Disagree' typo + other Likert variants in one file", async () => {
    // The fixture is a real multi-location file (Conrad & Westlake)
    // — its filename now correctly refuses to parse as one class.
    // To exercise Likert vocabulary tolerance independently of
    // filename routing, use the same path the manual-ingest button
    // uses: class_override pins the identity so the parser focuses
    // on the rows. Production multi-location files reach the same
    // code via splitMixedSurvey, which calls the same row-aggregator.
    const result = await parseSurvey({
      bytes: readFixture("survey-real-101-conrad-westlake.xlsx"),
      hint: "Survey Data PCBA 101 Conrad & Westlake_April 13-17.xlsx",
      ...baseEnvelope,
      class_override: {
        course_type: "BA101",
        class_date: "2026-04-13",
        location: "Conrad",
      },
    } as Parameters<typeof parseSurvey>[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const survey = (result.snapshots[0].source_payload as {
      survey: { response_count: number; average_score: number | null };
    }).survey;
    expect(survey.response_count).toBeGreaterThanOrEqual(40);
    /* The presence of disagree responses should pull the average below 5
       but still well above 1. */
    expect(survey.average_score!).toBeGreaterThan(2);
    expect(survey.average_score!).toBeLessThan(5);
  });
});

describe("parseMultiClassFilename", () => {
  it("returns both course types + date range from a true mixed-class filename", () => {
    const r = parseMultiClassFilename(
      "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
      2026,
    );
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.course_types.sort()).toEqual(["BA101", "BA102"]);
    expect(r.date_start).toBe("2026-04-06");
    expect(r.date_end).toBe("2026-04-10");
  });

  it("also handles single-course filenames (caller decides whether to use it)", () => {
    const r = parseMultiClassFilename(
      "Survey Data PCBA 101 Pendry March 23-27th.xlsx",
      2026,
    );
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.course_types).toEqual(["BA101"]);
    expect(r.date_start).toBe("2026-03-23");
    expect(r.date_end).toBe("2026-03-27");
  });

  it("returns null for filenames without a recognizable date range", () => {
    expect(parseMultiClassFilename("101 102 random.xlsx", 2026)).toBeNull();
  });

  it("returns null for filenames without any course code", () => {
    expect(
      parseMultiClassFilename("Survey Data April 6-10.xlsx", 2026),
    ).toBeNull();
  });
});

describe("splitMixedSurvey", () => {
  function row(opts: {
    first: string;
    last: string;
    ppn: string;
    prompt: string;
    response: string;
    qType?: "SINGLE_ANSWER" | "OPEN_ANSWER";
  }): RawRow {
    return {
      "Assessment Name": "Test",
      "First Name": opts.first,
      "Last Name": opts.last,
      Status: "ACTIVE",
      "PPN ID": opts.ppn,
      Role: null,
      "Submission Time": "2026-04-10T12:00:00Z",
      "Question Type": opts.qType ?? "SINGLE_ANSWER",
      Prompt: opts.prompt,
      Response: opts.response,
    };
  }

  const baseEnv = {
    filename: "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
    receivedAt: "2026-04-11T00:00:00Z",
    sourceMessageId: "msg_split_1",
    sourceArtifactId: "art_split_1",
  };

  it("routes respondents to the candidate class whose roster contains their PPN", () => {
    const rows: RawRow[] = [
      row({ first: "Alice", last: "Andrews", ppn: "aandrews", prompt: "Q1", response: "Strongly agree" }),
      row({ first: "Alice", last: "Andrews", ppn: "aandrews", prompt: "Q2", response: "Agree" }),
      row({ first: "Bob", last: "Brown", ppn: "bbrown", prompt: "Q1", response: "Disagree" }),
      row({ first: "Bob", last: "Brown", ppn: "bbrown", prompt: "Q2", response: "Strongly disagree" }),
      row({ first: "Carol", last: "Clark", ppn: "cclark", prompt: "Q1", response: "Strongly agree" }),
    ];

    const candidates = [
      {
        course_type: "BA101" as const,
        class_date: "2026-04-06",
        location: "Intercontinental",
        roster_ppns: new Set(["aandrews", "bbrown"]),
      },
      {
        course_type: "BA102" as const,
        class_date: "2026-04-06",
        location: "Conrad",
        roster_ppns: new Set(["cclark"]),
      },
    ];

    const snaps = splitMixedSurvey({ ...baseEnv, rows, candidateClasses: candidates });
    expect(snaps).toHaveLength(2);

    const intercontinental = snaps.find((s) => s.class.location === "Intercontinental");
    expect(intercontinental).toBeDefined();
    expect(intercontinental!.class.course_type).toBe("BA101");
    const intercontPayload = intercontinental!.source_payload as {
      survey: { response_count: number };
      auto_split_from_mixed_survey: boolean;
    };
    expect(intercontPayload.survey.response_count).toBe(2); // alice + bob
    expect(intercontPayload.auto_split_from_mixed_survey).toBe(true);

    const conrad = snaps.find((s) => s.class.location === "Conrad");
    expect(conrad).toBeDefined();
    expect(conrad!.class.course_type).toBe("BA102");
    const conradPayload = conrad!.source_payload as {
      survey: { response_count: number };
    };
    expect(conradPayload.survey.response_count).toBe(1); // carol
  });

  it("PPN ID is matched case-insensitively (roster lowercase, survey uppercase)", () => {
    const rows: RawRow[] = [
      row({ first: "A", last: "A", ppn: "AANDREWS", prompt: "Q1", response: "Agree" }),
    ];
    const candidates = [
      {
        course_type: "BA101" as const,
        class_date: "2026-04-06",
        location: "Intercontinental",
        roster_ppns: new Set(["aandrews"]), // lowercased on the roster side
      },
    ];
    const snaps = splitMixedSurvey({ ...baseEnv, rows, candidateClasses: candidates });
    expect(snaps).toHaveLength(1);
  });

  it("respondents whose PPN matches NO candidate are recorded under unmatched_respondents (never silently dropped)", () => {
    const rows: RawRow[] = [
      row({ first: "Alice", last: "Andrews", ppn: "aandrews", prompt: "Q1", response: "Agree" }),
      row({ first: "Walk", last: "In", ppn: "walkin1", prompt: "Q1", response: "Agree" }),
      row({ first: "No", last: "Ppn", ppn: "", prompt: "Q1", response: "Agree" }),
    ];
    const candidates = [
      {
        course_type: "BA101" as const,
        class_date: "2026-04-06",
        location: "Intercontinental",
        roster_ppns: new Set(["aandrews"]),
      },
    ];
    const snaps = splitMixedSurvey({ ...baseEnv, rows, candidateClasses: candidates });
    expect(snaps).toHaveLength(1);
    const payload = snaps[0].source_payload as {
      unmatched_respondents: Array<{ first: string; last: string; ppn_id: string | null }>;
    };
    expect(payload.unmatched_respondents).toBeDefined();
    expect(payload.unmatched_respondents).toHaveLength(2);
    const ppns = payload.unmatched_respondents.map((u) => u.ppn_id).sort();
    expect(ppns).toEqual([null, "walkin1"]);
  });

  it("returns [] when there are no candidate classes (caller falls through to quarantine)", () => {
    const rows: RawRow[] = [
      row({ first: "A", last: "A", ppn: "x", prompt: "Q1", response: "Agree" }),
    ];
    const snaps = splitMixedSurvey({ ...baseEnv, rows, candidateClasses: [] });
    expect(snaps).toEqual([]);
  });

  it("returns [] when there are no rows", () => {
    const candidates = [
      {
        course_type: "BA101" as const,
        class_date: "2026-04-06",
        location: "Intercontinental",
        roster_ppns: new Set(["aandrews"]),
      },
    ];
    const snaps = splitMixedSurvey({ ...baseEnv, rows: [], candidateClasses: candidates });
    expect(snaps).toEqual([]);
  });

  it("skips a candidate class whose bucket has no respondents (no misleading 0-response snapshot)", () => {
    const rows: RawRow[] = [
      row({ first: "A", last: "A", ppn: "aandrews", prompt: "Q1", response: "Agree" }),
    ];
    const candidates = [
      {
        course_type: "BA101" as const,
        class_date: "2026-04-06",
        location: "Intercontinental",
        roster_ppns: new Set(["aandrews"]),
      },
      {
        course_type: "BA102" as const,
        class_date: "2026-04-06",
        location: "Conrad",
        roster_ppns: new Set(["cclark"]), // nobody from this roster filed a response
      },
    ];
    const snaps = splitMixedSurvey({ ...baseEnv, rows, candidateClasses: candidates });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].class.location).toBe("Intercontinental");
  });

  it("handles a real mixed-class scenario stitched from two single-class fixtures", async () => {
    /* Stitch Pendry 101 + Intercontinental 102 rows into a synthetic
       mixed-class export, then re-route each respondent back to their
       original class via PPN ID match. The aggregate per class should
       match what the single-class parseSurvey produces. */
    const pendryBytes = fs.readFileSync(path.join(FIXTURES_DIR, "survey-real-101-pendry.xlsx"));
    const interBytes = fs.readFileSync(path.join(FIXTURES_DIR, "survey-real-102-intercontinental.xlsx"));
    const pendry = decodeSurveyRows(pendryBytes);
    const inter = decodeSurveyRows(interBytes);
    if ("error" in pendry) throw new Error(pendry.error);
    if ("error" in inter) throw new Error(inter.error);

    const ppnsPendry = new Set<string>();
    for (const r of pendry.rows) {
      const p = String(r["PPN ID"] ?? "").trim().toLowerCase();
      if (p) ppnsPendry.add(p);
    }
    const ppnsInter = new Set<string>();
    for (const r of inter.rows) {
      const p = String(r["PPN ID"] ?? "").trim().toLowerCase();
      if (p) ppnsInter.add(p);
    }

    const merged = [...pendry.rows, ...inter.rows];
    const snaps = splitMixedSurvey({
      ...baseEnv,
      filename: "Survey Data PCBA_March 16-27_101 Pendry & 102 Intercontinental.xlsx",
      rows: merged,
      candidateClasses: [
        {
          course_type: "BA101",
          class_date: "2026-03-23",
          location: "Pendry",
          roster_ppns: ppnsPendry,
        },
        {
          course_type: "BA102",
          class_date: "2026-03-16",
          location: "Intercontinental",
          roster_ppns: ppnsInter,
        },
      ],
    });

    expect(snaps).toHaveLength(2);
    const pendrySnap = snaps.find((s) => s.class.location === "Pendry")!;
    const interSnap = snaps.find((s) => s.class.location === "Intercontinental")!;
    expect(pendrySnap.class.course_type).toBe("BA101");
    expect(interSnap.class.course_type).toBe("BA102");

    const pendrySurvey = (pendrySnap.source_payload as { survey: { response_count: number } }).survey;
    const interSurvey = (interSnap.source_payload as { survey: { response_count: number } }).survey;
    expect(pendrySurvey.response_count).toBe(ppnsPendry.size);
    expect(interSurvey.response_count).toBe(ppnsInter.size);
  });
});

describe("decodeSurveyRows", () => {
  it("returns rows for a real fixture", () => {
    const bytes = readFixture("survey-real-101-pendry.xlsx");
    const r = decodeSurveyRows(bytes);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("returns error for non-xlsx bytes", () => {
    const r = decodeSurveyRows(Buffer.from("not an xlsx"));
    expect("error" in r).toBe(true);
  });
});

describe("parseSurvey · refusal paths", () => {
  it("returns parse_failure for an empty workbook", async () => {
    /* Build a minimal empty xlsx in-memory using xlsx writer. */
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Sheet1");
    const bytes = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const result = await parseSurvey({
      bytes,
      hint: "Survey Data PCBA 101 Pendry March 23-27th.xlsx",
      ...baseEnvelope,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exception_kind).toBe("parse_failure");
  });

  it("returns parse_failure with a 'multiple courses' message for ambiguous filenames", async () => {
    /* Real bytes don't matter — the filename refusal happens after the
       header probe but before aggregation. We pass a real fixture so
       header probe passes. */
    const result = await parseSurvey({
      bytes: readFixture("survey-real-101-pendry.xlsx"),
      hint: "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx",
      ...baseEnvelope,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/multiple courses/i);
  });
});
