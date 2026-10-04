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
    expect(s).toEqual({ topCandidatePath: null, topScore: 0, topReused: null, addsNewFile: true });
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

  it("an EDIT whose top candidate is a DIFFERENT file does NOT escalate (the benchmark bug)", () => {
    // Real case: "add a token to neon.ts" edited an existing file, but the scout
    // surfaced a different high-scoring file as the top candidate -> the edit does
    // not import it -> it was wrongly held as a "duplication". With the repo tree,
    // an edits-only change is known to add no new file, so it cannot be a dup.
    const repoTree = new Set(["src/components/neon.ts", "src/lib/other-theme.ts"]);
    const editOnly = [{ path: "src/components/neon.ts", content: "export const NEON = { info: '#6aa6ff' };" }];
    const cands = [{ path: "src/lib/other-theme.ts", score: 12 }]; // a DIFFERENT file scored top
    const s = duplicationSignal(cands, editOnly, aliasMap, repoTree);
    expect(s.addsNewFile).toBe(false);
    expect(duplicationGate(s).escalate).toBe(false); // was `true` before the fix
  });

  it("a NEW file that re-implements a strong candidate STILL escalates (gate intact)", () => {
    const repoTree = new Set(["src/lib/ai-code/grading.ts"]);
    const newFile = [{ path: "src/app/brand-new-report.ts", content: "export function report(x: unknown[]) { return x.length; }" }];
    const cands = [{ path: "src/lib/ai-code/grading.ts", score: 8 }];
    const s = duplicationSignal(cands, newFile, aliasMap, repoTree);
    expect(s.addsNewFile).toBe(true);
    expect(duplicationGate(s).escalate).toBe(true); // the real dup case is unaffected
  });
});

describe("duplicationGate (the DRY gate - this is what should have caught the detector-duplication incident)", () => {
  it("ESCALATES when a strong existing module was NOT reused (likely re-implementation)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/cost-summary.ts", topScore: 8, topReused: false, addsNewFile: true });
    expect(g.escalate).toBe(true);
    expect(g.candidatePath).toBe("src/lib/cost-summary.ts");
    expect(g.reason).toMatch(/re-implement|reuse/i);
  });

  it("does NOT escalate when the strong candidate WAS reused (imported)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/cost-summary.ts", topScore: 12, topReused: true, addsNewFile: true });
    expect(g.escalate).toBe(false);
    expect(g.reason).toBeNull();
  });

  it("does NOT escalate on a weak/coarse score below the threshold (precision - no noise)", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/thing.ts", topScore: STRONG_DUPLICATION_SCORE - 1, topReused: false, addsNewFile: true });
    expect(g.escalate).toBe(false);
  });

  it("does NOT escalate when there was no candidate at all", () => {
    const g = duplicationGate({ topCandidatePath: null, topScore: 0, topReused: null, addsNewFile: true });
    expect(g.escalate).toBe(false);
  });

  it("fires exactly at the threshold boundary", () => {
    expect(duplicationGate({ topCandidatePath: "a.ts", topScore: STRONG_DUPLICATION_SCORE, topReused: false, addsNewFile: true }).escalate).toBe(true);
  });

  it("NEVER escalates an EDITS-ONLY change (a strong candidate but no new file) - the benchmark bug", () => {
    const g = duplicationGate({ topCandidatePath: "src/lib/cost-summary.ts", topScore: 12, topReused: false, addsNewFile: false });
    expect(g.escalate).toBe(false); // editing existing files cannot be a re-implementation
  });
});
