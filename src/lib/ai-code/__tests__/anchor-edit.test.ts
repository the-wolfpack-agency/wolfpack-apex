/**
 * Anchor edits - the large-file edit mode. The apply must be deterministic and
 * fail-closed: an anchor that is missing or ambiguous NEVER edits, it escalates.
 */
import { parseAnchorEdits, applyAnchorEdits } from "@/lib/ai-code/anchor-edit";

const block = (path: string, search: string, replace: string) =>
  `EDIT ${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe("parseAnchorEdits", () => {
  it("parses a single edit", () => {
    const e = parseAnchorEdits(block("src/x.ts", "const a = 1;", "const a = 2;"));
    expect(e).toEqual([{ path: "src/x.ts", search: "const a = 1;", replace: "const a = 2;" }]);
  });
  it("parses multiple edits across files, ignoring surrounding prose/fences", () => {
    const reply = "Here are the edits:\n```\n" + block("a.ts", "foo", "bar") + "\n" + block("b.ts", "baz\nqux", "zap") + "\n```\nDone.";
    const e = parseAnchorEdits(reply);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ path: "a.ts", search: "foo", replace: "bar" });
    expect(e[1]).toMatchObject({ path: "b.ts", search: "baz\nqux", replace: "zap" });
  });
  it("strips quotes around the path", () => {
    expect(parseAnchorEdits(block('"src/x.ts"', "a", "b"))[0].path).toBe("src/x.ts");
  });
  it("ignores a malformed block with no end marker", () => {
    expect(parseAnchorEdits("EDIT a.ts\n<<<<<<< SEARCH\nfoo\n=======\nbar")).toEqual([]);
  });
});

describe("applyAnchorEdits (deterministic + fail-closed)", () => {
  const files = { "a.ts": "line1\nconst k = 1;\nline3", "b.ts": "x\nx\nkeep" };

  it("applies a clean, unique anchor", () => {
    const r = applyAnchorEdits(files, [{ path: "a.ts", search: "const k = 1;", replace: "const k = 2;" }]);
    expect(r.failures).toEqual([]);
    expect(r.appliedCount).toBe(1);
    expect(r.changes).toEqual([{ path: "a.ts", content: "line1\nconst k = 2;\nline3" }]);
  });
  it("fails (never edits) when the anchor is not found", () => {
    const r = applyAnchorEdits(files, [{ path: "a.ts", search: "const k = 99;", replace: "x" }]);
    expect(r.changes).toEqual([]);
    expect(r.failures).toEqual([{ path: "a.ts", reason: "anchor_not_found" }]);
  });
  it("fails when the anchor is ambiguous (matches more than once)", () => {
    const r = applyAnchorEdits(files, [{ path: "b.ts", search: "x", replace: "y" }]);
    expect(r.changes).toEqual([]);
    expect(r.failures).toEqual([{ path: "b.ts", reason: "anchor_ambiguous" }]);
  });
  it("fails when the file was not provided, and when the search is empty", () => {
    expect(applyAnchorEdits(files, [{ path: "missing.ts", search: "a", replace: "b" }]).failures[0].reason).toBe("file_not_provided");
    expect(applyAnchorEdits(files, [{ path: "a.ts", search: "", replace: "b" }]).failures[0].reason).toBe("empty_search");
  });
  it("applies multiple edits to the same file in order", () => {
    const r = applyAnchorEdits({ "a.ts": "AAA\nBBB" }, [
      { path: "a.ts", search: "AAA", replace: "aaa" },
      { path: "a.ts", search: "BBB", replace: "bbb" },
    ]);
    expect(r.appliedCount).toBe(2);
    expect(r.changes[0].content).toBe("aaa\nbbb");
  });
  it("applies a good edit and reports a bad one in the same batch (partial, explicit)", () => {
    const r = applyAnchorEdits(files, [
      { path: "a.ts", search: "const k = 1;", replace: "const k = 2;" },
      { path: "a.ts", search: "nope", replace: "x" },
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.failures).toEqual([{ path: "a.ts", reason: "anchor_not_found" }]);
  });
});

describe("applyAnchorEdits — whitespace-tolerant fallback (the large-file rescue)", () => {
  it("applies when the SEARCH differs only by per-line TRAILING whitespace", () => {
    // The live file has trailing spaces the model did not reproduce.
    const file = "function f() {\n  const x = 1;   \n  return x;\n}\n";
    const edits = [{ path: "a.ts", search: "  const x = 1;\n  return x;", replace: "  const x = 2;\n  return x * 2;" }];
    const r = applyAnchorEdits({ "a.ts": file }, edits);
    expect(r.failures).toEqual([]);
    expect(r.appliedCount).toBe(1);
    expect(r.changes[0].content).toBe("function f() {\n  const x = 2;\n  return x * 2;\n}\n");
  });

  it("stays fail-closed: an ambiguous trailing-trimmed match NEVER edits", () => {
    const file = "a = 1;\nb = 2;\n\na = 1;\nb = 2;\n"; // two identical spans
    const r = applyAnchorEdits({ "a.ts": file }, [{ path: "a.ts", search: "a = 1;\nb = 2;", replace: "X" }]);
    expect(r.appliedCount).toBe(0);
    expect(r.failures).toEqual([{ path: "a.ts", reason: "anchor_ambiguous" }]);
  });

  it("still reports anchor_not_found when nothing matches even trimmed", () => {
    const r = applyAnchorEdits({ "a.ts": "const a = 1;\n" }, [{ path: "a.ts", search: "const z = 9;", replace: "X" }]);
    expect(r.appliedCount).toBe(0);
    expect(r.failures).toEqual([{ path: "a.ts", reason: "anchor_not_found" }]);
  });

  it("prefers the exact match (fast path) and leaves exact behavior unchanged", () => {
    const r = applyAnchorEdits({ "a.ts": "const a = 1;\n" }, [{ path: "a.ts", search: "const a = 1;", replace: "const a = 2;" }]);
    expect(r.appliedCount).toBe(1);
    expect(r.changes[0].content).toBe("const a = 2;\n");
  });
});

describe("anchorFailureFeedback (the tier-escalation retry prompt)", () => {
  it("names the failures and demands verbatim SEARCH text", () => {
    const { anchorFailureFeedback } = require("@/lib/ai-code/anchor-edit");
    const msg = anchorFailureFeedback([
      { path: "src/big.tsx", reason: "anchor_not_found" },
      { path: "src/big.tsx", reason: "anchor_not_found" },
    ]);
    expect(msg).toMatch(/2 anchor failure/);
    expect(msg).toContain("src/big.tsx");
    expect(msg).toMatch(/CHARACTER-FOR-CHARACTER|verbatim/);
  });
});
