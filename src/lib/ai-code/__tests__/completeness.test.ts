/**
 * Completeness check: a test file with no test case is incomplete (the apex
 * fragment that parsed but could never pass jest). Parseability != completeness.
 */
import { isTestFile, findIncompleteFiles, completenessFeedback } from "@/lib/ai-code/completeness";

describe("isTestFile", () => {
  it.each([
    ["src/x.test.ts", true],
    ["src/x.spec.tsx", true],
    ["src/lib/__tests__/y.ts", true],
    ["src/x.ts", false],
    ["src/lib/util.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe("findIncompleteFiles", () => {
  it("flags a test file with NO test case (the fragment that slipped through)", () => {
    const files = [{ path: "src/__tests__/x.test.ts", content: `const lines = src.split("\\n");` }];
    const out = findIncompleteFiles(files);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("src/__tests__/x.test.ts");
    expect(out[0].reason).toMatch(/no test case/i);
  });

  it("does NOT flag a test file that has real test cases", () => {
    const files = [{ path: "src/x.test.ts", content: `describe("x", () => { it("works", () => { expect(1).toBe(1); }); });` }];
    expect(findIncompleteFiles(files)).toEqual([]);
  });

  it("recognizes it.each / test.only as test cases", () => {
    const files = [
      { path: "a.test.ts", content: `it.each([[1]])("n", (n) => expect(n).toBe(1));` },
      { path: "b.test.ts", content: `test.only("y", () => expect(true).toBe(true));` },
    ];
    expect(findIncompleteFiles(files)).toEqual([]);
  });

  it("does NOT flag a non-test source file with no test call", () => {
    const files = [{ path: "src/lib/util.ts", content: `export const x = 1;` }];
    expect(findIncompleteFiles(files)).toEqual([]);
  });
});

describe("completenessFeedback", () => {
  it("names the incomplete file and asks for real test cases", () => {
    const fb = completenessFeedback([{ path: "a.test.ts", content: "" } as never].map(() => ({ path: "a.test.ts", reason: "test file contains no test case" })));
    expect(fb).toMatch(/INCOMPLETE/);
    expect(fb).toMatch(/a\.test\.ts/);
    expect(fb).toMatch(/real, executable test cases/i);
  });
});
