/**
 * Production-readiness RATCHET.
 *
 * Scans the real repo and asserts every tracked tool's readiness score is at or
 * above its recorded floor in readiness-baseline.json. The floor can only go UP:
 * a change that lowers a tool's readiness fails here, and closing a gap means
 * raising the floor in the same PR. This is the mechanism that turns the
 * readiness engine into forward progress instead of a number that drifts.
 *
 * Mirrors the soft-spec-ratchet / reality-check-workflow pattern: a guardrail
 * that reads the actual source tree (not a mock), so it measures reality.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { READINESS_TOOLS } from "@/lib/readiness/catalog";
import { reportTool, scorePct } from "@/lib/readiness/report";
import { createFsReader } from "../../scripts/readiness-fs-reader";

const ROOT = process.cwd();
const baseline: { scores: Record<string, number> } = JSON.parse(
  readFileSync(join(ROOT, "readiness-baseline.json"), "utf8"),
);
const reader = createFsReader(ROOT);

describe("production-readiness ratchet (scores may only climb)", () => {
  it("every tracked tool has a baseline entry (no silent drop-off)", () => {
    for (const t of READINESS_TOOLS) {
      expect(baseline.scores[t.id]).toBeDefined();
    }
  });

  it.each(READINESS_TOOLS.map((t) => [t.id, t] as const))(
    "%s readiness is at or above its baseline floor",
    (_id, spec) => {
      const live = scorePct(reportTool(spec, reader).score);
      const floor = baseline.scores[spec.id] ?? 0;
      expect(live).toBeGreaterThanOrEqual(floor);
    },
  );

  it("the baseline is not stale-high (a floor above the live score is a lie)", () => {
    // If someone bumped a floor without the code to back it, this catches it.
    for (const spec of READINESS_TOOLS) {
      const live = scorePct(reportTool(spec, reader).score);
      const floor = baseline.scores[spec.id] ?? 0;
      expect(floor).toBeLessThanOrEqual(live);
    }
  });
});
