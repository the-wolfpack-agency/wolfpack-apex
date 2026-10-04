/**
 * #3 correction analysis: the deterministic diff-of-diffs. Given what the factory
 * authored and what a human merged, detect + categorize the human correction.
 */
import { analyzeCorrection, addedLinesByFile, buildCorrectionBlock } from "@/lib/ai-code/factory-correction-analysis";

const d = (path: string, added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${added.map((l) => "+" + l).join("\n")}`;

describe("addedLinesByFile", () => {
  it("groups trimmed added lines by file, skips blanks + headers", () => {
    const m = addedLinesByFile(d("src/a.ts", ["  const x = 1;  ", "", "const y = 2;"]));
    expect(m.get("src/a.ts")).toEqual(["const x = 1;", "const y = 2;"]);
  });
});

describe("analyzeCorrection", () => {
  it("identical authored + merged -> not edited", () => {
    const diff = d("src/a.ts", ["const x = 1;"]);
    const a = analyzeCorrection(diff, diff);
    expect(a.edited).toBe(false);
    expect(a.humanAdded).toBe(0);
    expect(a.humanRemoved).toBe(0);
    expect(a.categories).toEqual([]);
  });

  it("human ADDED a test file -> edited + tests/new-files categories", () => {
    const authored = d("src/a.ts", ["export const x = 1;"]);
    const merged = authored + "\n" + d("src/__tests__/a.test.ts", ["it('works', () => expect(x).toBe(1));"]);
    const a = analyzeCorrection(authored, merged);
    expect(a.edited).toBe(true);
    expect(a.categories).toEqual(expect.arrayContaining(["tests", "new-files"]));
    expect(a.filesTouchedByHuman).toBe(1);
  });

  it("human ADDED error handling + an import -> those categories", () => {
    const authored = d("src/a.ts", ["doWork();"]);
    const merged = d("src/a.ts", ["import { log } from '@/lib/log';", "try { doWork(); } catch (e) { throw e; }"]);
    const a = analyzeCorrection(authored, merged);
    expect(a.edited).toBe(true);
    expect(a.categories).toEqual(expect.arrayContaining(["error-handling", "imports"]));
    expect(a.humanAdded).toBeGreaterThan(0);
  });

  it("human REMOVED a line the factory authored -> removed-code + humanRemoved", () => {
    const authored = d("src/a.ts", ["const keep = 1;", "const trimmed = 2;"]);
    const merged = d("src/a.ts", ["const keep = 1;"]);
    const a = analyzeCorrection(authored, merged);
    expect(a.edited).toBe(true);
    expect(a.humanRemoved).toBe(1);
    expect(a.categories).toContain("removed-code");
  });

  it("ignores whitespace-only reformatting (trim) -> not edited", () => {
    const authored = d("src/a.ts", ["const x = 1;"]);
    const merged = d("src/a.ts", ["   const x = 1;   "]);
    expect(analyzeCorrection(authored, merged).edited).toBe(false);
  });
});

describe("buildCorrectionBlock", () => {
  it("is empty below the rate threshold", () => {
    expect(buildCorrectionBlock([{ category: "tests", rate: 0.2 }])).toBe("");
    expect(buildCorrectionBlock([])).toBe("");
  });
  it("renders advice for dominant categories", () => {
    const b = buildCorrectionBlock([{ category: "tests", rate: 0.8 }, { category: "error-handling", rate: 0.5 }]);
    expect(b).toMatch(/HUMAN CORRECTIONS/);
    expect(b).toMatch(/include tests/);
    expect(b).toMatch(/handle errors/);
  });
});
