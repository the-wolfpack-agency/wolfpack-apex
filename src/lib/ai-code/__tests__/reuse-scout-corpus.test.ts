/**
 * The reuse-scout's WARM path: when semantic reuse is on and a workspace is known,
 * findReuseCandidates searches the PERSISTED corpus index (factory brain) and
 * merges its hits with the keyword candidates, instead of embedding candidates
 * in-memory every run. Cold/empty corpus -> falls back to keyword-only here (the
 * in-memory fallback needs a real embedder, mocked absent).
 */
const mockFetchTree = jest.fn();
const mockSearchCorpus = jest.fn();
jest.mock("@/lib/github-client", () => ({ fetchRepoTree: (...a: unknown[]) => mockFetchTree(...a) }));
jest.mock("@/lib/ai-code/factory-reuse-index", () => ({ searchReuseCorpus: (...a: unknown[]) => mockSearchCorpus(...a) }));
// No embedder in tests -> the in-memory cold path resolves to keyword-only.
jest.mock("@/lib/rag-providers/factory", () => ({ getEmbeddingProvider: () => { throw new Error("unconfigured"); } }));

import { findReuseCandidates } from "@/lib/ai-code/reuse-scout";

const TREE = ["src/lib/cost-summary.ts", "src/components/Button.tsx"];
const OLD = process.env.AI_CODE_SEMANTIC_REUSE;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchTree.mockResolvedValue(TREE);
  process.env.AI_CODE_SEMANTIC_REUSE = "on";
});
afterAll(() => { if (OLD === undefined) delete process.env.AI_CODE_SEMANTIC_REUSE; else process.env.AI_CODE_SEMANTIC_REUSE = OLD; });

it("merges persisted corpus hits with keyword candidates (warm path)", async () => {
  // The corpus surfaces a synonym match the keyword scout misses.
  mockSearchCorpus.mockResolvedValue([{ path: "src/lib/cost-summary.ts", score: 0.91 }]);
  const r = await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "add a spending tracker", workspaceId: "w1" });
  expect(mockSearchCorpus).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", repo: "o/r", query: "add a spending tracker" }));
  expect(r.candidates.map((c) => c.path)).toContain("src/lib/cost-summary.ts");
  expect(r.semantic).toBe(true);
});

it("excludes prompt-named paths from the corpus hits", async () => {
  mockSearchCorpus.mockResolvedValue([{ path: "src/lib/cost-summary.ts", score: 0.9 }]);
  const r = await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "x", workspaceId: "w1", excludePaths: ["src/lib/cost-summary.ts"] });
  expect(r.candidates.map((c) => c.path)).not.toContain("src/lib/cost-summary.ts");
});

it("falls back to keyword-only when the corpus is cold (no hits, no embedder)", async () => {
  mockSearchCorpus.mockResolvedValue([]);
  const r = await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "nothing matches here", workspaceId: "w1" });
  expect(r.semantic).toBe(false); // in-memory path returned null (embedder absent)
});

it("never searches the corpus without a workspaceId", async () => {
  mockSearchCorpus.mockResolvedValue([{ path: "src/lib/cost-summary.ts", score: 0.9 }]);
  await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "x" }); // no workspaceId
  expect(mockSearchCorpus).not.toHaveBeenCalled();
});

it("never searches the corpus when the flag is off", async () => {
  process.env.AI_CODE_SEMANTIC_REUSE = "off";
  await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "x", workspaceId: "w1" });
  expect(mockSearchCorpus).not.toHaveBeenCalled();
});
