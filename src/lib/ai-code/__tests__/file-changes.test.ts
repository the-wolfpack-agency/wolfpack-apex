/** @jest-environment node
 *
 * Full-file changes: parse the executor's full-file output and commit each via
 * the Contents API (create OR update = edit-support with no patch math). A path
 * escaping the tree is refused before any write.
 */
const createBranch = jest.fn();
const putFile = jest.fn();
jest.mock("@/lib/github-client", () => ({
  createBranch: (...a: unknown[]) => createBranch(...a),
  putFile: (...a: unknown[]) => putFile(...a),
}));

import { parseFileChanges, isSafeRepoPath, commitFileChanges } from "../file-changes";

const REPLY = [
  "Here are the changes:",
  "FILE: src/lib/strings.ts",
  "```ts",
  "export const isPalindrome = (s: string) => s === [...s].reverse().join('');",
  "```",
  "and the test:",
  "FILE: src/lib/__tests__/strings.test.ts",
  "```ts",
  "import { isPalindrome } from '../strings';",
  "expect(isPalindrome('aba')).toBe(true);",
  "```",
].join("\n");

describe("parseFileChanges", () => {
  it("extracts every FILE block with its full content", () => {
    const changes = parseFileChanges(REPLY);
    expect(changes.map((c) => c.path)).toEqual(["src/lib/strings.ts", "src/lib/__tests__/strings.test.ts"]);
    expect(changes[0].content).toContain("isPalindrome");
    expect(changes[0].content).not.toMatch(/```/);
  });
  it("returns [] when the reply has no FILE blocks", () => {
    expect(parseFileChanges("no files here")).toEqual([]);
  });
});

describe("isSafeRepoPath", () => {
  it("accepts a normal repo path, rejects traversal and absolute", () => {
    expect(isSafeRepoPath("src/lib/x.ts")).toBe(true);
    expect(isSafeRepoPath("../etc/passwd")).toBe(false);
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
  });
});

describe("commitFileChanges", () => {
  beforeEach(() => { jest.clearAllMocks(); createBranch.mockResolvedValue(undefined); putFile.mockResolvedValue(undefined); });

  it("creates the branch and putFiles each change (create-or-update)", async () => {
    const client = { token: "t", fetch: globalThis.fetch };
    const committed = await commitFileChanges({
      client, repoFullName: "o/r", branch: "factory/x", base: "main",
      changes: [{ path: "src/a.ts", content: "export const a = 1;" }, { path: "src/b.ts", content: "export const b = 2;" }],
      message: "factory: x",
    });
    expect(committed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(createBranch).toHaveBeenCalledWith(client, "o/r", "factory/x", "main");
    expect(putFile).toHaveBeenCalledTimes(2);
  });

  it("refuses an unsafe path before any write", async () => {
    const client = { token: "t", fetch: globalThis.fetch };
    await expect(
      commitFileChanges({ client, repoFullName: "o/r", branch: "b", base: "main", changes: [{ path: "../evil", content: "x" }], message: "m" }),
    ).rejects.toThrow(/unsafe file path/);
    expect(createBranch).not.toHaveBeenCalled();
    expect(putFile).not.toHaveBeenCalled();
  });
});
