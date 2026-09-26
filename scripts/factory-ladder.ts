/**
 * Prove the capability ladder LIVE: cheapest model first, escalate only when it
 * cannot meet the standard, against a REAL environment.
 *
 *   npm run factory:ladder
 *
 * A task is handed to each tier (cheap -> standard -> premium). Each tier authors
 * a diff; the diff's new file is executed against a graded test in the sandbox;
 * the ladder stops at the first tier that passes and reports which one, and the
 * spend. This is model efficiency + model-agnostic safety, demonstrated end to
 * end: prompt in, code generated, executed in the product, gated before output.
 *
 * Honest by design: a tier with no configured deployment shows up as an
 * unavailable attempt (the ladder escalates past it), never a fake pass. Exits
 * non-zero if no tier met the standard, so a green exit means a real pass.
 */
import "./load-env";
import { getAIClient } from "@/lib/ai";
import { authorDiff } from "@/lib/ai-code/author";
import { runCapabilityLadder, type LadderTask } from "@/lib/ai-code/capability-ladder";
import { makeSandboxOracle } from "@/lib/ai-code/oracle";
import type { AIModelTier } from "@/lib/ai/types";

const TASK: LadderTask = {
  id: "is-palindrome",
  prompt:
    "Create a NEW file `solution.mjs` that exports a function `isPalindrome(s)` " +
    "returning true iff the string is a palindrome, ignoring case and any " +
    "non-alphanumeric characters. Output ONLY the unified diff that creates " +
    "solution.mjs (ESM, plain JavaScript).",
};

// Our graded test. The model never sees or edits this; the oracle writes it into
// the sandbox after the model's file and runs it.
const GRADED = {
  "test.mjs": `import { isPalindrome } from "./solution.mjs";
import assert from "node:assert";
assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true, "classic palindrome");
assert.equal(isPalindrome("racecar"), true, "simple palindrome");
assert.equal(isPalindrome("hello"), false, "non-palindrome");
assert.equal(isPalindrome("No 'x' in Nixon"), true, "punctuated palindrome");
console.log("all graded tests passed");`,
};

async function main(): Promise<void> {
  const client = getAIClient();
  const oracle = makeSandboxOracle(GRADED, ["node", "test.mjs"], 10_000);

  const author = (tier: AIModelTier) =>
    authorDiff(
      { prompt: TASK.prompt, tier, executorProviderPin: "azure-openai", feature: "factory-ladder" },
      { complete: (r) => client.complete(r) },
    );

  const res = await runCapabilityLadder({ task: TASK, author, runOracle: oracle });

  console.log("\n=== capability ladder (cheapest-first, oracle-gated) ===\n");
  console.log(`Task: ${TASK.id}\n`);
  for (const a of res.attempts) {
    const cost = a.costUsd === null ? "" : `  ~$${a.costUsd.toFixed(5)}`;
    const verdict = a.oraclePassed ? "PASS" : a.gamed ? "GAMED" : !a.diffPresent ? "NO-DIFF" : "FAIL";
    console.log(`  [${verdict.padEnd(7)}] ${a.tier.padEnd(9)} ${(a.author || "?").padEnd(18)} ${a.provider ?? ""}${cost}`);
    console.log(`            ${a.oracleDetail}${a.error ? `  (${a.error})` : ""}`);
  }
  console.log(`\n${res.summary}`);
  console.log(`cleared by: ${res.clearedBy ?? "(none)"}\n`);

  if (!res.clearedBy) {
    console.log("NOT PROVEN: no tier met the standard in this environment.");
    console.log("If tiers show NO-DIFF, configure the Azure chat deployments:");
    console.log("  - cheap:    AZURE_OPENAI_DEPLOYMENT_CHEAP (gpt-4o-mini)");
    console.log("  - standard: AZURE_OPENAI_DEPLOYMENT_STANDARD (gpt-4o)");
    console.log("  - a different family (cross-family judging): the Foundry vars for DeepSeek/Llama.\n");
    process.exit(1);
  }
  console.log("PROVEN: a real model wrote code that was EXECUTED and passed the graded standard,");
  console.log("selected cheapest-first, with the whole loop gated by the product.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
