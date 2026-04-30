/**
 * One-shot diagnostic — runs the production cognito_coordinator
 * and cognito_instructor parsers against every .eml the user
 * dropped in ~/Downloads/Automating Class Summaries. Build-tooling-
 * first per the global invariant: don't let an AI guess at parser
 * compatibility, run the actual parser.
 *
 * Skipped automatically when the folder isn't present (other devs).
 */

import * as fs from "fs";
import * as path from "path";

import { parseCognitoCoordinator } from "@/lib/automations/porsche-classes/parser-cognito-coordinator";
import { parseCognitoInstructor } from "@/lib/automations/porsche-classes/parser-cognito-instructor";
import {
  parseSurvey,
  parseClassIdentityFromFilename,
  parseMultiClassFilename,
  decodeSurveyRows,
} from "@/lib/automations/porsche-classes/parser-survey";
import { parseXlsx } from "@/lib/automations/porsche-classes/parser-xlsx";

const DIR = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "Automating Class Summaries",
);
const SURVEY_DIR = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "Program Evals",
);
const ROSTER_DIR = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "Automating Porsche Class Participant Updates_Changes",
);

const folderPresent = fs.existsSync(DIR);
const surveyFolderPresent = fs.existsSync(SURVEY_DIR);
const rosterFolderPresent = fs.existsSync(ROSTER_DIR);

function findSurveyFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".xlsx")) out.push(full);
    }
  }
  return out.sort();
}

(folderPresent ? describe : describe.skip)(
  "Real Cognito .eml samples — parsers still work end-to-end",
  () => {
    const files = folderPresent
      ? fs
          .readdirSync(DIR)
          .filter((f) => f.endsWith(".eml"))
          .sort()
      : [];

    test.each(files)("parses %s without falling back to fail()", async (f) => {
      const full = path.join(DIR, f);
      const bytes = fs.readFileSync(full);
      const isCoord = /Coordinator Class Report/i.test(f);
      const parser = isCoord ? parseCognitoCoordinator : parseCognitoInstructor;

      const result = await parser({
        bytes,
        hint: f,
        // Synthetic IDs — the parser only uses these for snapshot
        // attribution, not for routing/decisions.
        message_id: `diagnostic:${f}`,
        artifact_id: `diagnostic:${f}:body`,
      } as any);

      // Surface the structured failure when it fails — diff-friendly.
      if (!result.ok) {
         
        console.error(
          `[${f}] parser returned !ok: ${result.error}`,
          result.detail ?? {},
        );
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source_type).toBe(
          isCoord ? "cognito_coordinator" : "cognito_instructor",
        );
        const snaps = (result as any).snapshots;
        expect(Array.isArray(snaps)).toBe(true);
        expect(snaps.length).toBeGreaterThan(0);
        const s = snaps[0];
        expect(s.source_payload?.class_key).toMatch(/.+\|.+\|.+/);
        expect(s.class?.course_type).toBeTruthy();
        expect(s.class?.class_date).toBeTruthy();
         
        console.log(
          `[${f}] ok class_key=${s.source_payload.class_key} course=${s.class.course_type} date=${s.class.class_date} location="${s.class.location}"`,
        );
      }
    });
  },
);

(surveyFolderPresent ? describe : describe.skip)(
  "Real survey .xlsx samples — single-class + multi-class filename detection",
  () => {
    const files = surveyFolderPresent ? findSurveyFiles(SURVEY_DIR) : [];

    test.each(files)("decodes %s without choking on the workbook", async (full) => {
      const bytes = fs.readFileSync(full);
      const decoded = decodeSurveyRows(bytes);
      if ("error" in decoded) {
         
        console.error(`[${path.basename(full)}] decodeSurveyRows failed:`, decoded.error);
      }
      expect("error" in decoded).toBe(false);
      if (!("error" in decoded)) {
         
        console.log(
          `[${path.basename(full)}] rows=${decoded.rows.length}`,
        );
      }
    });

    test.each(files)(
      "classifies %s as single-class OR multi-class via filename heuristics",
      async (full) => {
        const filename = path.basename(full);
        const fallbackYear = 2026;
        const single = parseClassIdentityFromFilename(filename, fallbackYear);
        const multi = parseMultiClassFilename(filename, fallbackYear);

        // Multi-class file is either: (a) two distinct course codes,
        // or (b) one course code with two locations joined by "&"/"and".
        const isSameCourseMultiLocation =
          multi !== null &&
          multi.course_types.length === 1 &&
          /(\s&\s|\sand\s)/i.test(filename);
        if (
          (multi && multi.course_types.length > 1) ||
          isSameCourseMultiLocation
        ) {
          // Multi-class file: parseSurvey MUST refuse with a
          // structured error containing "multiple courses" or
          // "multiple locations" so the orchestrator routes to
          // splitMixedSurvey. Asserting both the refusal AND the
          // error keyword the orchestrator looks for closes the
          // class of bugs where the parser silently mis-classifies
          // a multi-location file as single-class.
          const result = await parseSurvey({
            bytes: fs.readFileSync(full),
            hint: filename,
            received_at: new Date().toISOString(),
            source_message_id: `diagnostic:${filename}`,
            source_artifact_id: `diagnostic:${filename}:body`,
          } as any);
           
          console.log(
            `[${filename}] multi-class detected (sameCourseMultiLocation=${isSameCourseMultiLocation}) parseSurvey.ok=${result.ok}`,
          );
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toMatch(/multiple (courses|locations)/i);
          }
        } else {
          // Single-class file. Hard-assert success.
          const result = await parseSurvey({
            bytes: fs.readFileSync(full),
            hint: filename,
            received_at: new Date().toISOString(),
            source_message_id: `diagnostic:${filename}`,
            source_artifact_id: `diagnostic:${filename}:body`,
          } as any);
          if (!result.ok) {
             
            console.error(
              `[${filename}] parseSurvey returned !ok: ${result.error}`,
              (result as any).detail ?? {},
            );
          }
          expect(result.ok).toBe(true);
          if (result.ok) {
            const snaps = (result as any).snapshots;
            const s = snaps[0];
            const survey = s.source_payload?.survey;
             
            console.log(
              `[${filename}] ok class_key=${s.class.course_type}|${s.class.class_date}|${s.class.location} respondents=${survey?.response_count ?? "?"} questions=${survey?.questions?.length ?? "?"}`,
            );
            expect(s.class.course_type).toMatch(/^BA10[12]$/);
            expect(s.class.class_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(s.class.location).toBeTruthy();
          }
          expect(single).toBeDefined();
        }
      },
    );
  },
);

(rosterFolderPresent ? describe : describe.skip)(
  "Real Porsche academy participant-updates samples — xlsx parser end-to-end",
  () => {
    const xlsxFiles = rosterFolderPresent
      ? fs
          .readdirSync(ROSTER_DIR)
          .filter((f) => f.endsWith(".xlsx"))
          .sort()
      : [];

    test.each(xlsxFiles)("parseXlsx ingests %s without falling back to fail()", async (f) => {
      const full = path.join(ROSTER_DIR, f);
      const bytes = fs.readFileSync(full);
      const result = await parseXlsx({
        bytes,
        hint: f,
        received_at: new Date().toISOString(),
        source_message_id: `diagnostic:${f}`,
        source_artifact_id: `diagnostic:${f}:body`,
      } as Parameters<typeof parseXlsx>[0]);

      if (!result.ok) {
         
        console.error(
          `[${f}] parseXlsx returned !ok: ${result.error}`,
          (result as any).detail ?? {},
        );
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        const snaps = (result as any).snapshots;
        expect(Array.isArray(snaps)).toBe(true);
        expect(snaps.length).toBeGreaterThan(0);
         
        console.log(
          `[${f}] ok snapshot_count=${snaps.length} first_class=${snaps[0]?.class?.course_type}|${snaps[0]?.class?.class_date}|${snaps[0]?.class?.location} participants=${snaps[0]?.class?.participants?.length ?? 0}`,
        );
      }
    });
  },
);
