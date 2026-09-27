/**
 * The factory never commits a merge-conflict marker: containsConflictMarkers is
 * the deterministic rule, and commitFileChanges fails closed before any GitHub
 * write when an authored file carries one.
 */
import { containsConflictMarkers, commitFileChanges } from "@/lib/ai-code/file-changes";

describe("containsConflictMarkers", () => {
  it("flags the open, close, and diff3 markers", () => {
    expect(containsConflictMarkers("a\n<<<<<<< HEAD\nb")).toBe(true);
    expect(containsConflictMarkers("a\n>>>>>>> origin/main\nb")).toBe(true);
    expect(containsConflictMarkers("a\n||||||| base\nb")).toBe(true);
  });
  it("does NOT flag legitimate code or a markdown divider", () => {
    expect(containsConflictMarkers("export const x = 1;\n// =======\n")).toBe(false);
    expect(containsConflictMarkers("Title\n=======\nbody")).toBe(false); // md underline
    expect(containsConflictMarkers("if (a < b && c > d) {}")).toBe(false);
  });
});

describe("commitFileChanges rejects conflict markers before any write", () => {
  const client = { token: "t", fetch: jest.fn() } as never;

  it("throws (no GitHub call) when an authored file carries a marker", async () => {
    const fetchSpy = (client as { fetch: jest.Mock }).fetch;
    await expect(
      commitFileChanges({
        client,
        repoFullName: "o/r",
        branch: "b",
        base: "main",
        changes: [{ path: "src/x.ts", content: "<<<<<<< HEAD\nexport const x = 1;\n>>>>>>> other\n" }],
        message: "m",
      }),
    ).rejects.toThrow(/conflict marker/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // failed closed before any commit
  });
});
