/**
 * @jest-environment node
 *
 * The oracle turns an authored diff into runnable files and executes the graded
 * test in the sandbox (real subprocess). It must: extract new-file contents,
 * run our graded test against them, pass green / fail red, ignore a diff that
 * creates nothing, and never let the model overwrite the graded test.
 */
import { newFilesFromDiff, makeSandboxOracle } from "../oracle";

const TASK = { id: "pal", prompt: "create isPalindrome" };

const GOOD_DIFF = `diff --git a/solution.mjs b/solution.mjs
new file mode 100644
--- /dev/null
+++ b/solution.mjs
@@ -0,0 +1,3 @@
+export const isPalindrome = (s) => {
+  const c = s.toLowerCase().replace(/[^a-z0-9]/g, "");
+  return c === [...c].reverse().join("");
+};`;

const BAD_DIFF = GOOD_DIFF.replace("=== [...c].reverse().join(\"\")", "=== s");

describe("newFilesFromDiff", () => {
  it("extracts the post-image of a created file", () => {
    const files = newFilesFromDiff(GOOD_DIFF);
    expect(Object.keys(files)).toEqual(["solution.mjs"]);
    expect(files["solution.mjs"]).toContain("export const isPalindrome");
    expect(files["solution.mjs"]).not.toContain("+export"); // the + markers are stripped
  });
  it("returns nothing for a diff that creates no files", () => {
    expect(newFilesFromDiff("just some prose, no diff")).toEqual({});
  });
});

describe("makeSandboxOracle", () => {
  const graded = {
    "test.mjs": `import { isPalindrome } from "./solution.mjs";
import assert from "node:assert";
assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true);
assert.equal(isPalindrome("nope"), false);
console.log("ok");`,
  };
  const oracle = makeSandboxOracle(graded, ["node", "test.mjs"]);

  it("PASSES when the authored solution satisfies the graded test", async () => {
    const res = await oracle(GOOD_DIFF, TASK);
    expect(res.passed).toBe(true);
  }, 15_000);

  it("FAILS when the authored solution is wrong", async () => {
    const res = await oracle(BAD_DIFF, TASK);
    expect(res.passed).toBe(false);
    expect(res.detail.length).toBeGreaterThan(0);
  }, 15_000);

  it("fails cleanly when the diff creates no runnable file", async () => {
    const res = await oracle("no diff here", TASK);
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/no new files/);
  });
});
