/**
 * Thin wrapper. The logic, and its tests, live in src/lib/ci/soft-spec-ratchet.ts.
 *
 * Usage: tsx scripts/soft-spec-ratchet.ts <playwright-json> [baseline-json]
 */
import { readFileSync } from "node:fs";
import { parseResults, compare } from "../src/lib/ci/soft-spec-ratchet";

const [, , resultsPath, baselinePath = "tests/e2e/known-soft-failures.json"] = process.argv;
if (!resultsPath) {
  console.error("usage: tsx scripts/soft-spec-ratchet.ts <playwright-json> [baseline-json]");
  process.exit(2);
}

const outcomes = parseResults(JSON.parse(readFileSync(resultsPath, "utf8")));
const baseline: Record<string, string> =
  JSON.parse(readFileSync(baselinePath, "utf8")).failures ?? {};
const r = compare(outcomes, baseline);

/* If the walk returns nothing, this whole gate asserts nothing, which is the
   exact failure it exists to prevent. Every guardrail in this repo that skipped
   this check has been found reporting health while broken. */
if (r.total === 0) {
  console.error(
    `No spec results parsed from ${resultsPath}. A ratchet with nothing to compare ` +
      `is a green tick that means nothing, so this is a failure, not a pass.`,
  );
  process.exit(1);
}

const say = (title: string, keys: string[]) => {
  if (keys.length === 0) return;
  console.log(`\n${title} (${keys.length})`);
  for (const k of keys) console.log(`  ${k}`);
};

console.log(`${r.total} specs ran. ${r.knownFailures.length + r.newFailures.length} failed.`);
say("Known, tolerated", r.knownFailures);
say("Flaky (passed on retry)", r.flaky);
say("NOW PASSING, remove from the baseline", r.nowPassing);
say("On the baseline but absent from this run (renamed, deleted, or never ran)", r.missing);
say("NEW FAILURES, not on the baseline", r.newFailures);

if (r.newFailures.length > 0) {
  console.error(
    `\n${r.newFailures.length} test(s) started failing and are not in ${baselinePath}. ` +
      `Fix them, or add them with a reason somebody can act on. The list may shrink ` +
      `and may not silently grow.`,
  );
  process.exit(1);
}
console.log("\nNo new failures. The pile did not grow.");
