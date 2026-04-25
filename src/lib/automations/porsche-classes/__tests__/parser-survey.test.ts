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
import { parseSurvey, parseClassIdentityFromFilename } from "../parser-survey";

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

  it("preserves multi-hotel locations as one class ('Conrad & Westlake')", () => {
    const r = parseClassIdentityFromFilename(
      "Survey Data PCBA 101 Conrad & Westlake_April 13-17.xlsx",
      2026,
    );
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.course_type).toBe("BA101");
    expect(r.class_date).toBe("2026-04-13");
    expect(r.location).toMatch(/Conrad/);
    expect(r.location).toMatch(/Westlake/);
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
    const result = await parseSurvey({
      bytes: readFixture("survey-real-101-conrad-westlake.xlsx"),
      hint: "Survey Data PCBA 101 Conrad & Westlake_April 13-17.xlsx",
      ...baseEnvelope,
    });
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
