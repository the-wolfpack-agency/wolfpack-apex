/**
 * Shadow duplication detection - did the change reuse the top existing module the
 * reuse-scout found, or re-implement it? Recorded (not enforced) to tune the
 * escalation threshold from real data.
 */
import { changeImportsPath, changeImportSpecifiers, duplicationSignal } from "@/lib/ai-code/reuse-enforcement";

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
});
