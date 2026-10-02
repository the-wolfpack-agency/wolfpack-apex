/**
 * Shadow duplication detection - did the change reuse the top existing module the
 * reuse-scout found, or re-implement it? Recorded (not enforced) to tune the
 * escalation threshold from real data.
 */
import {
  changeImportsPath,
  changeImportSpecifiers,
  duplicationSignal,
  duplicationGate,
  STRONG_DUPLICATION_SCORE,
} from "@/lib/ai-code/reuse-enforcement";

const aliasMap = { "@/": "src/" };

describe("changeImportSpecifiers", () => {
  it("collects every local import the change makes", () => {
    const files = [
      { path: "src/app/x.ts", content: `import { a } from "@/lib/one";\nimport b from "../two";` },
      { path: "src/app/y.ts", content: `import { c } from "zod";` }, // bare pkg -> ignored
    ];
    const specs = changeImportSpecifiers(files);
    expect(specs.has("@/lib/one")).toBe(true);
    expect(specs.has("../two")).toBe(true);
    expect(specs.has("zod")).toBe(false);
  });
});

describe("changeImportsPath", () => {
  const files = [{ path: "src/app/report.ts", content: `import { gradeRuns } from "@/lib/ai-code/grading";` }];
  it("true when the change imports the candidate module (via its alias specifier)", () => {
    expect(changeImportsPath(files, "src/lib/ai-code/grading.ts", aliasMap)).toBe(true);
  });
  it("false when it does not (a re-implementation)", () => {
    expect(changeImportsPath(files, "src/lib/ai-code/runs.ts", aliasMap)).toBe(false);
  });
});

describe("duplicationSignal", () => {
  const gradingReused = [{ path: "src/app/report.ts", content: `import { gradeRuns } from "@/lib/ai-code/grading";\nexport const r = gradeRuns;` }];
  const reimplemented = [{ path: "src/app/report.ts", content: `export function report(x: unknown[]) { return x.length; }` }];
  const candidates = [{ path: "src/lib/ai-code/grading.ts", score: 8 }, { path: "src/lib/ai-code/runs.ts", score: 4 }];

  it("reports the top candidate + that it WAS reused", () => {
    const s = duplicationSignal(candidates, gradingReused, aliasMap);
    expect(s.topCandidatePath).toBe("src/lib/ai-code/grading.ts");
    expect(s.topScore).toBe(8);
    expect(s.topReused).toBe(true);
  });

  it("flags the likely duplication: a high-score module that was NOT reused", () => {
    const s = duplicationSignal(candidates, reimplemented, aliasMap);
    expect(s.topScore).toBe(8);
    expect(s.topReused).toBe(false); // re-implemented instead of importing the real grader
  });

  it("topReused is null when the scout found no candidate (nothing to reuse)", () => {
    const s = duplicationSignal([], reimplemented, aliasMap);
    expect(s).toEqual({ topCandidatePath: null, topScore: 0, topReused: null });
  });

  it("EDITING the top candidate file counts as reuse, not re-implementation (the self-edit false positive)", () => {
    // The change modifies the candidate file itself - you cannot import a file you
    // are editing, so this must NOT read as an un-reused duplication.
    const edit = [{ path: "src/lib/ai-code/grading.ts", content: "export function gradeRuns() { return 1; }" }];
    const s = duplicationSignal(candidates, edit, aliasMap);
    expect(s.topCandidatePath).toBe("src/lib/ai-code/grading.ts");
    expect(s.topReused).toBe(true);
    // ...and therefore the DRY gate does NOT escalate a legitimate in-file edit.
    expect(duplicationGate(s).escalate).toBe(false);
  });
});

describe("duplicationGate (the DRY gate - this is what should have caught the detector-duplication incident)", () => {
  it("ESCALATES when a strong existing module was NOT reused (likely re-implementation)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/cost-summary.ts", topScore: 8, topReused: false });
    expect(g.escalate).toBe(true);
    expect(g.candidatePath).toBe("src/lib/cost-summary.ts");
    expect(g.reason).toMatch(/re-implement|reuse/i);
  });

  it("does NOT escalate when the strong candidate WAS reused (imported)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/cost-summary.ts", topScore: 12, topReused: true });
    expect(g.escalate).toBe(false);
    expect(g.reason).toBeNull();
  });

  it("does NOT escalate on a weak/coarse score below the threshold (precision - no noise)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/thing.ts", topScore: STRONG_DUPLICATION_SCORE - 1, topReused: false });
    expect(g.escalate).toBe(false);
  });

  it("does NOT escalate when there was no candidate at all", () => {
    const g = duplicationGate({ topCandidatePath: null, topScore: 0, topReused: null });
    expect(g.escalate).toBe(false);
  });

  it("fires exactly at the threshold boundary", () => {
    expect(duplicationGate({ topCandidatePath: "a.ts", topScore: STRONG_DUPLICATION_SCORE, topReused: false }).escalate).toBe(true);
  });
});
