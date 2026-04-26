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

const DIR = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "Automating Class Summaries",
);

const folderPresent = fs.existsSync(DIR);

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
        // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.log(
          `[${f}] ok class_key=${s.source_payload.class_key} course=${s.class.course_type} date=${s.class.class_date} location="${s.class.location}"`,
        );
      }
    });
  },
);
