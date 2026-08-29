/**
 * A failure that records nothing is a failure nobody can find.
 *
 * WHAT THIS COST
 *
 * tryBrain caught every error from queryBrain and returned an empty context
 * with no record at all. gateUngroundedClaimAboutUs reads an empty context as
 * "nothing was retrieved" and rejects the answer, so a broken retrieval and an
 * empty corpus produced the same sentence for the reader and the same silence
 * for us.
 *
 * Five hypotheses died against that one blind spot over several hours: the
 * semantic score floor, the query phrasing, whether semantic ran at all, an
 * unguarded analytics await, and a swallowed exception. Each was plausible,
 * each was measured, and the answer was in a code path nothing reported on.
 *
 * WHY A RATCHET RATHER THAN A BAN
 *
 * There are 88 of these. A guard that fails on all of them gets disabled in a
 * day, and a disabled guard is worse than none because it looks like coverage.
 * So the count is snapshotted per file and may only go DOWN: a new one fails
 * the build, an existing one is visible and costed. Same shape as the unrun-spec
 * backlog, for the same reason.
 *
 * NOT EVERY SILENT CATCH IS WRONG. "Best effort, the user still gets their
 * answer" is often exactly right. What is never right is being unable to tell
 * that it happened. A comment counts as recording here: it does not help at
 * runtime, but it proves somebody decided rather than defaulted, and it tells
 * the next reader which of the two they are looking at.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");

/** The answer path: where a swallowed failure reaches a person. */
const WATCHED = ["src/lib/assistant", "src/lib/brain"];

/**
 * Snapshot taken 2026-08-29. MAY ONLY GO DOWN.
 *
 * Removing an entry means the file no longer swallows silently. Adding one, or
 * raising a number, is not allowed: record something, or write the comment
 * saying why nothing needs recording.
 */
const SILENT_CATCH_BASELINE: Record<string, number> = {
  "src/lib/assistant/answer-quality.ts": 2,
  "src/lib/assistant/attachment-context.ts": 1,
  "src/lib/assistant/chat-ingest.ts": 2,
  "src/lib/assistant/connectors/credentials.ts": 7,
  "src/lib/assistant/connectors/oauth/providers/hubspot.ts": 2,
  "src/lib/assistant/connectors/oauth/providers/salesforce.ts": 2,
  "src/lib/assistant/connectors/oauth/refresh.ts": 1,
  "src/lib/assistant/connectors/rest-connector.ts": 2,
  "src/lib/assistant/context-resolver.ts": 1,
  "src/lib/assistant/follow-through.ts": 1,
  "src/lib/assistant/forms/execute.ts": 2,
  "src/lib/assistant/image-compress.ts": 3,
  "src/lib/assistant/learning.ts": 2,
  "src/lib/assistant/routines/day-plan.ts": 1,
  "src/lib/assistant/routines/heal.ts": 1,
  "src/lib/assistant/routines/human-insight.ts": 1,
  "src/lib/assistant/routines/saved.ts": 3,
  "src/lib/assistant/routines/schedule-store.ts": 4,
  "src/lib/assistant/routines/schedule.ts": 1,
  "src/lib/assistant/routines/slots.ts": 1,
  "src/lib/assistant/routines/store.ts": 3,
  "src/lib/assistant/routines/sweep.ts": 2,
  "src/lib/assistant/tools/brain-history.ts": 1,
  "src/lib/assistant/tools/calendar-availability.ts": 1,
  "src/lib/assistant/tools/compare-across-sources-tool.ts": 1,
  "src/lib/assistant/tools/create-external-record-tool.ts": 1,
  "src/lib/assistant/tools/dark-data-tool.ts": 1,
  "src/lib/assistant/tools/dispatcher.ts": 2,
  "src/lib/assistant/tools/dms-inventory-widget-tool.ts": 1,
  "src/lib/assistant/tools/get-calendar-availability-tool.ts": 1,
  "src/lib/assistant/tools/get-financials-metric-tool.ts": 1,
  "src/lib/assistant/tools/get-goals-tool.ts": 1,
  "src/lib/assistant/tools/get-org-facts.ts": 1,
  "src/lib/assistant/tools/github-query-client.ts": 1,
  "src/lib/assistant/tools/goals-lookup.ts": 1,
  "src/lib/assistant/tools/mail-search.ts": 1,
  "src/lib/assistant/tools/meeting-prep.ts": 1,
  "src/lib/assistant/tools/pending-actions.ts": 3,
  "src/lib/assistant/tools/plan-my-day-tool.ts": 1,
  "src/lib/assistant/tools/save-team-fact-tool.ts": 1,
  "src/lib/assistant/tools/schedule-health-tool.ts": 1,
  "src/lib/assistant/tools/search-mail-tool.ts": 1,
  "src/lib/assistant/tools/search.ts": 1,
  "src/lib/assistant/tools/update-external-record-tool.ts": 1,
  "src/lib/assistant/tools/who-is-tool.ts": 4,
  "src/lib/brain/audience.ts": 1,
  "src/lib/brain/enrich.ts": 1,
  "src/lib/brain/extractor.ts": 4,
  "src/lib/brain/ingest.ts": 2,
  "src/lib/brain/qdrant.ts": 1,
  "src/lib/brain/query.ts": 2,
  "src/lib/brain/relevance.ts": 1,
  "src/lib/brain/repo.ts": 1,
  "src/lib/brain/reprocess.ts": 1,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!p.includes("__tests__")) walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** A catch is "silent" when its body neither records nor explains itself. */
function countSilentCatches(source: string): number {
  const re = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\n\s*\}/g;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(source))) {
    const body = match[1] ?? "";
    const explains = /\/\*|\/\//.test(body);
    const records = /trackEvent|console\.|throw |logger|reportError/.test(body);
    if (!explains && !records) n++;
  }
  return n;
}

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of WATCHED) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      const n = countSilentCatches(readFileSync(file, "utf8"));
      if (n > 0) counts[rel] = n;
    }
  }
  return counts;
}

describe("no new silent failures in the answer path", () => {
  const current = currentCounts();

  /* THE RATCHET. A new silent catch, or one more in a file that already has
     some, fails here. */
  it("adds no silent catch to any file", () => {
    const grew: string[] = [];
    for (const [file, n] of Object.entries(current)) {
      const allowed = SILENT_CATCH_BASELINE[file] ?? 0;
      if (n > allowed) grew.push(`${file}: ${allowed} -> ${n}`);
    }
    expect(
      grew.join("\n") ||
        "none",
    ).toBe("none");
  });

  /* Keeps the list honest. A file that gets fixed should leave the baseline,
     or the number stops meaning anything and the ratchet stops ratcheting. */
  it("has no stale baseline entries", () => {
    const stale = Object.keys(SILENT_CATCH_BASELINE).filter(
      (f) => (current[f] ?? 0) < (SILENT_CATCH_BASELINE[f] ?? 0),
    );
    expect(
      stale.length === 0
        ? "none"
        : `these improved and the baseline should be lowered:\n${stale.join("\n")}`,
    ).toBe("none");
  });

  /* The total is recorded so the direction of travel is visible in one number
     rather than spread across fifty entries. */
  it("keeps the total visible", () => {
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    const baseline = Object.values(SILENT_CATCH_BASELINE).reduce((a, b) => a + b, 0);
    expect(`${total} <= ${baseline}`).toBe(`${Math.min(total, baseline)} <= ${baseline}`);
  });
});
