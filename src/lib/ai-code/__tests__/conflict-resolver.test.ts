/**
 * resolveConflicts: auto keep-both for additive factory conflicts, safe by
 * default. One-sided and disjoint-additive hunks resolve; overlapping edits are
 * left semantic (null resolved) so they escalate instead of guessing.
 */
import { resolveConflicts } from "@/lib/ai-code/conflict-resolver";

const conflict = (ours: string, theirs: string) =>
  `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> branch`;

test("no markers -> content returned unchanged, auto-resolvable", () => {
  const r = resolveConflicts("const x = 1;\nconst y = 2;\n");
  expect(r.hadConflicts).toBe(false);
  expect(r.autoResolvable).toBe(true);
  expect(r.resolved).toBe("const x = 1;\nconst y = 2;\n");
});

test("one side empty -> keep the non-empty side (pure addition)", () => {
  const r = resolveConflicts(conflict("export const a = 1;", ""));
  expect(r.hunks[0].kind).toBe("ours-only");
  expect(r.autoResolvable).toBe(true);
  expect(r.resolved).toContain("export const a = 1;");
});

test("disjoint additions (two different functions) -> KEEP BOTH", () => {
  const ours = "export function foo() {\n  return 1;\n}";
  const theirs = "export function bar() {\n  return 2;\n}";
  const r = resolveConflicts(conflict(ours, theirs));
  expect(r.hunks[0].kind).toBe("keep-both");
  expect(r.autoResolvable).toBe(true);
  expect(r.resolved).toContain("function foo()");
  expect(r.resolved).toContain("function bar()");
  // ours first, then theirs
  expect(r.resolved!.indexOf("foo")).toBeLessThan(r.resolved!.indexOf("bar"));
});

test("two additions that share only a structural brace are still KEEP BOTH", () => {
  // Braces/blank lines are ignored for overlap, so two independent blocks that
  // both contain a lone "}" do not read as a semantic clash.
  const ours = "const a = 1;\n}";
  const theirs = "const b = 2;\n}";
  const r = resolveConflicts(conflict(ours, theirs));
  expect(r.hunks[0].kind).toBe("keep-both");
  expect(r.resolved).toContain("const a = 1;");
  expect(r.resolved).toContain("const b = 2;");
});

test("overlapping edits to the SAME significant line -> semantic, not auto-resolved", () => {
  const r = resolveConflicts(conflict("const timeout = 30;", "const timeout = 60;"));
  expect(r.hunks[0].kind).toBe("semantic");
  expect(r.autoResolvable).toBe(false);
  expect(r.resolved).toBeNull(); // escalate, never guess
});

test("mixed hunks: one keep-both + one semantic -> NOT auto-resolvable overall", () => {
  const content =
    conflict("export const a = 1;", "export const b = 2;") +
    "\nconst shared = true;\n" +
    conflict("const v = 'x';", "const v = 'y';");
  const r = resolveConflicts(content);
  expect(r.hunks.map((h) => h.kind)).toEqual(["keep-both", "semantic"]);
  expect(r.autoResolvable).toBe(false);
  expect(r.resolved).toBeNull();
});

test("diff3 markers: the base section is ignored, ours/theirs still resolve", () => {
  const content = "<<<<<<< HEAD\nexport const a = 1;\n||||||| base\n=======\nexport const b = 2;\n>>>>>>> branch";
  const r = resolveConflicts(content);
  expect(r.hunks[0].kind).toBe("keep-both");
  expect(r.resolved).toContain("export const a = 1;");
  expect(r.resolved).toContain("export const b = 2;");
});

test("surrounding context outside the hunk is preserved", () => {
  const content = `import x from "x";\n${conflict("export const a = 1;", "export const b = 2;")}\nexport default x;`;
  const r = resolveConflicts(content);
  expect(r.resolved).toContain('import x from "x";');
  expect(r.resolved).toContain("export default x;");
});
