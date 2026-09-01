/**
 * A module whose only caller is its own test has not shipped.
 *
 * THE FAILURE THIS EXISTS FOR. #386 built a relevance judge for exactly the
 * problem it was aimed at - the Brain returning something rather than the
 * right thing - tested it, measured it at 9% precision against the real index,
 * and wrote that number into a pull request. It was never called.
 * judgeRelevance was imported by relevance.test.ts and nothing else, so
 * production went on quoting whatever cleared the score floor, and on
 * 2026-08-25 answered a question about meeting briefs with three chunks of
 * Porsche Brand Ambassador training material.
 *
 * Every check was green the whole time. The unit tests passed, because the
 * judge worked. The measurement was real, because it was measured offline.
 * Nothing in the suite asked the only question that mattered: is it connected?
 *
 * That is the same shape as every other bug this codebase keeps finding - a
 * probe reading a splash, a soft CI step that could not fail, a fleet section
 * that hid instead of saying none. Silence presented as health. So the check
 * is structural on purpose: it does not care what a module does, only that
 * something other than its own test asks it to.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BRAIN = path.join(ROOT, "src/lib/brain");

/**
 * A SCRIPT IS NOT THE PRODUCT, which is the distinction that makes this test
 * work at all.
 *
 * The first version of this counted scripts/ as callers and passed with the
 * judge unwired, because scripts/brain-eval.ts imports it - that is the
 * offline harness that produced the 9% precision number. Being measured is not
 * being shipped, and the gap between those two is the whole bug.
 *
 * So the caller has to live in src/. Anything genuinely script-only is listed
 * here with the reason, and the list is short on purpose.
 */
const SCRIPT_ONLY_BY_DESIGN: Record<string, string> = {
  "backfill.ts":
    "a maintenance job run by hand via scripts/brain-backfill.ts; it embeds documents that predate the embedder and has no place in a request path",
  "retrieval-eval.ts":
    "a measurement, not a request path: scripts/eval-retrieval.ts grades labeled question-to-document pairs so a ranking change can be judged instead of argued. Wiring it into a request would make every question pay for an evaluation nobody asked for",
};

/** Files with nothing to call. */
const NOT_CALLED_BY_DESIGN = new Set([
  "types.ts", // type-only surface
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "__tests__") sourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/* APPLICATION CODE ONLY. See SCRIPT_ONLY_BY_DESIGN above. */
const callers = sourceFiles(path.join(ROOT, "src")).filter(
  (f) => !f.includes("__tests__") && !f.endsWith(".test.ts"),
);

const modules = fs
  .readdirSync(BRAIN)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !NOT_CALLED_BY_DESIGN.has(f));

describe("every brain module is actually reachable from the product", () => {
  it.each(modules)("%s is reached from the product, not only from a test", (file) => {
    const stem = file.replace(/\.ts$/, "");
    const self = path.join(BRAIN, file);
    /* Both spellings, because a dynamic import is still a caller. Missing it
       reported backfill.ts as unwired when scripts/brain-backfill.ts reaches
       it through `await import("../src/lib/brain/backfill")`, and a guard
       that cries wolf gets an allowlist entry instead of a fix. */
    const pattern = new RegExp(
      `(?:from|import)\\s*\\(?\\s*["'][^"']*(?:/|^)brain/${stem}["']` +
        `|(?:from|import)\\s*\\(?\\s*["']\\.{1,2}/${stem}["']`,
    );
    const importers = callers.filter(
      (f) => f !== self && pattern.test(fs.readFileSync(f, "utf8")),
    );
    if (SCRIPT_ONLY_BY_DESIGN[file]) {
      /* Allowed, but it still has to be run by SOMETHING, and the reason has
         to be written down where the next person will read it. */
      expect(SCRIPT_ONLY_BY_DESIGN[file].length).toBeGreaterThan(20);
      return;
    }
    expect(importers.length).toBeGreaterThan(0);
  });
});
