/**
 * fetchRepoGrounding caches the built block per (repo, ref) for a few minutes, so
 * repeated factory runs against the same repo do not refetch the whole recursive
 * tree + package.json every time.
 */
const mockTree = jest.fn();
const mockFile = jest.fn();
jest.mock("@/lib/github-client", () => ({
  fetchRepoTree: (...a: unknown[]) => mockTree(...a),
  fetchFileContent: (...a: unknown[]) => mockFile(...a),
}));

import { fetchRepoGrounding, __clearGroundingCache } from "@/lib/ai-code/repo-grounding";

const client = { token: "t", fetch: jest.fn() } as never;

beforeEach(() => {
  jest.clearAllMocks();
  __clearGroundingCache();
  mockTree.mockResolvedValue(["src/lib/db.ts"]);
  mockFile.mockResolvedValue(JSON.stringify({ dependencies: { next: "15" } }));
});

test("a second call within the TTL is served from cache (tree fetched once)", async () => {
  const a = await fetchRepoGrounding(client, "o/r", "main");
  const b = await fetchRepoGrounding(client, "o/r", "main");
  expect(a).toBe(b);
  expect(a).toContain("src/lib/db.ts");
  expect(mockTree).toHaveBeenCalledTimes(1);
  expect(mockFile).toHaveBeenCalledTimes(1);
});

test("different repo/ref keys are fetched independently", async () => {
  await fetchRepoGrounding(client, "o/r1", "main");
  await fetchRepoGrounding(client, "o/r2", "main");
  await fetchRepoGrounding(client, "o/r1", "develop");
  expect(mockTree).toHaveBeenCalledTimes(3); // three distinct keys
});

test("__clearGroundingCache forces a refetch", async () => {
  await fetchRepoGrounding(client, "o/r", "main");
  __clearGroundingCache();
  await fetchRepoGrounding(client, "o/r", "main");
  expect(mockTree).toHaveBeenCalledTimes(2);
});
