/**
 * The ratchet: silent catches in the answer path may fall and may not rise.
 *
 * A catch that returns an empty array turns "the query threw" into "there were
 * no results", and every layer above then reports the absence honestly. That
 * cost an afternoon and five discarded hypotheses once already.
 *
 * NOT ZERO, AND NOT A WALL. There were 172 when this was written. Failing the
 * build on all of them would mean the check gets deleted within a day, so it
 * holds the line and rewards moving it. Lower the number with
 * `npm run scan:silent-catches -- --write` after removing some.
 */
import fs from "node:fs";
import path from "node:path";
import { readCatches } from "../silent-catch";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const BASELINE = path.join(REPO, "src/lib/ci/__generated__/silent-catch-baseline.json");
const ROOTS = ["src/lib/assistant", "src/lib/brain", "src/lib/search", "src/lib/ai"];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("silent catches in the answer path", () => {
  const reading = readCatches(
    ROOTS.flatMap((r) => walk(path.join(REPO, r))).map((f) => ({
      path: path.relative(REPO, f),
      source: fs.readFileSync(f, "utf-8"),
    })),
  );
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf-8")) as {
    silentCount: number;
  };

  it("does not rise above the committed baseline", () => {
    /* Thrown rather than asserted, because the fix belongs in the failure. A
       message that is only a number sends somebody to read the scanner
       instead of their own diff. */
    if (reading.silent.length > baseline.silentCount) {
      const worst = [...new Set(reading.silent.map((v) => v.site.file))].slice(0, 5);
      throw new Error(
        `${reading.silent.length} silent catches in the answer path, baseline ${baseline.silentCount}.\n` +
          `A catch that says nothing turns a failure into an absence, and every layer above\n` +
          `it then reports the absence honestly.\n\n` +
          `Report it: a log, trackEvent, a degradation note, or a rethrow.\n` +
          `Or declare it quiet WITH A REASON, which the scanner accepts.\n\n` +
          `Files with silent catches: ${worst.join(", ")}`,
      );
    }
    expect(reading.silent.length).toBeLessThanOrEqual(baseline.silentCount);
  });

  it("has a baseline that is not stale by more than it should be", () => {
    /* If the real number has fallen well below the baseline, the ratchet has
       gone slack and stopped protecting the gap that was closed. */
    expect(baseline.silentCount - reading.silent.length).toBeLessThanOrEqual(10);
  });

  /* The scan finding nothing at all would mean it broke, not that the code got
     perfect overnight. A guardrail that silently stops looking is the same
     defect it exists to catch. */
  it("is actually still scanning", () => {
    expect(reading.verdicts.length).toBeGreaterThan(50);
    expect(reading.reports.length).toBeGreaterThan(0);
  });
});
