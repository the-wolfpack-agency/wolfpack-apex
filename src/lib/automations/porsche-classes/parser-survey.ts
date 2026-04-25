/**
 * Porsche Academy class survey parser — STUB.
 *
 * The survey aggregate is the third leg of the per-class summary (after
 * coordinator + instructor reports). Format unknown: Alicia hasn't sent
 * a real fixture yet. This stub returns a structured ParseFailure so
 * the ingest orchestrator can:
 *   1. surface a clear "needs format spec" exception in the queue
 *   2. defer the artifact instead of silently dropping it
 *   3. let us flip the implementation in once a real fixture lands
 *
 * TODO — what we need from Alicia before this stub becomes a real parser:
 *   ───────────────────────────────────────────────────────────────────
 *   1. ONE real survey delivery for any past class (preferably with
 *      multiple respondents), in whichever format she actually receives
 *      them today (PDF export from Porsche LMS? CSV? Cognito? SurveyMonkey?
 *      Forwarded email?). Save into `__fixtures__/` next to the others.
 *   2. The exact set of rating questions — we expect a 1-5 Likert scale
 *      but the question wording must match for the byLabel lookup.
 *   3. Confirmation of whether responses are anonymized or include
 *      attendee names (drives whether `survey.responses[].name` is
 *      populated and whether we need to scrub PII before storage).
 *   4. The aggregation rule Alicia uses today: simple per-question
 *      average, weighted average, count-of-5s, etc. — drives the
 *      `SurveyAggregate` shape in `types.ts`.
 *   5. The "class identity" fields the survey carries (course / date /
 *      location) so we can deterministically build a `class_key` and
 *      route the snapshot to the right summary.
 *   ───────────────────────────────────────────────────────────────────
 *
 * Once the above is in hand, replace this body with a real parser that
 * follows the same shape as `parser-cognito-coordinator.ts` (ideally
 * sharing `cognito-html.ts` if it turns out to be a Cognito form;
 * otherwise add a new `survey-format.ts` helper that's exhaustively
 * tested against the fixture).
 */

import type { ParseInput, ParseResult, Parser } from "../types";

const SOURCE_TYPE = "survey" as const;

const NEEDS_FORMAT_SPEC_MESSAGE =
  "Survey format not yet specified — provide a real fixture and update parser-survey.ts";

export const parseSurvey: Parser = async (
  input: ParseInput,
): Promise<ParseResult> => {
  return {
    ok: false,
    source_type: SOURCE_TYPE,
    error: NEEDS_FORMAT_SPEC_MESSAGE,
    exception_kind: "parse_failure",
    detail: {
      stub: true,
      hint: input.hint,
      received_at: input.received_at,
      todo: [
        "Need a real survey fixture from Alicia (any past class)",
        "Confirm question set + 1-5 scale wording",
        "Confirm anonymized vs named responses",
        "Confirm aggregation rule (mean / weighted / count-of-5s)",
        "Confirm class identity fields (course / date / location) on the survey",
      ],
    },
  };
};

export default parseSurvey;

/**
 * Exported for tests + documentation. Lets a CI assertion verify the
 * stub message hasn't been silently mutated (which would break the
 * "needs format spec" exception filter in the dashboard).
 */
export const SURVEY_STUB_MESSAGE = NEEDS_FORMAT_SPEC_MESSAGE;
