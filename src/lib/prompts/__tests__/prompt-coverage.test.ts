/**
 * Migration guardrail: the list of files still building a system prompt inline
 * may SHRINK, never grow.
 *
 * Twelve files construct a system prompt as a string literal today. Rewriting
 * all twelve in one change would be a large, risky diff across unrelated
 * surfaces — the assistant, support triage, document classification, meeting
 * insights — with no way to verify each one except by using it.
 *
 * So the debt is written down instead, and this test makes it a ratchet. A new
 * inline prompt fails the build. Migrating one means deleting a line from the
 * list. That is the same shape as provider-coverage.test.ts, which already
 * works in this repo for exactly this reason.
 *
 * The point is not that inline prompts are ugly. It is that a prompt built
 * inline has no version to bisect against, no declared scope, and no id an
 * eval can score — so it is the one part of an agent that cannot be measured.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIB = join(__dirname, "..", "..");

/**
 * Files that still build a system prompt inline. Each one is a migration to
 * src/lib/prompts. Delete a line when you move one; never add one.
 */
const KNOWN_INLINE_PROMPTS: readonly string[] = [
  "agents/tasks/reasoning.ts",
  "ai/draft-provider.ts",
  "assistant.ts",
  "automations/meeting-insights/analyzer/index.ts",
  "brief-parser.ts",
  "claude-report-generator.ts",
  "document-recognition/classifier.ts",
  "insights/meeting-prep-synthesize.ts",
  "knowledge/qa-cache.ts",
  "support/pattern-library.ts",
];

/** The marker for "this string is addressed to a model". Deliberately narrow:
 *  a broad heuristic would catch prose in comments and make the ratchet noisy
 *  enough to be disabled, which is how a guardrail dies. */
const SYSTEM_PROMPT_MARKER = /["'`]You are /;

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      if (entry === "__tests__" || entry === "prompts") continue;
      out.push(...walk(abs, rel));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("inline system prompts are a shrinking list", () => {
  const offenders = walk(LIB).filter((rel) => SYSTEM_PROMPT_MARKER.test(readFileSync(join(LIB, rel), "utf-8")));

  it("has no inline prompt that is not on the known list", () => {
    const unlisted = offenders.filter((f) => !KNOWN_INLINE_PROMPTS.includes(f));
    expect(
      unlisted.length === 0
        ? []
        : unlisted.map((f) => `${f} builds a system prompt inline — register it in src/lib/prompts instead`),
    ).toEqual([]);
  });

  it("has no stale entry, so the list cannot quietly overstate the debt", () => {
    // A list that never shrinks reads as progress that never happened. An
    // entry for a file that no longer has an inline prompt has to be deleted.
    const stale = KNOWN_INLINE_PROMPTS.filter((f) => !offenders.includes(f));
    expect(stale.map((f) => `${f} no longer has an inline prompt — remove it from KNOWN_INLINE_PROMPTS`)).toEqual([]);
  });

  it("records the debt as a number, so the trend is visible", () => {
    // Update this deliberately when it changes. The direction is the point.
    // 12 -> 10: support.categorize and support.auto_acknowledge are registered.
    expect(KNOWN_INLINE_PROMPTS.length).toBe(10);
  });
});
