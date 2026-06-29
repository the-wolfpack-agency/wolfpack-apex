/**
 * Discovery orchestrator: detects AI usage across files (real detectors),
 * persists via the store, and returns the discovered set + summary. The store
 * write is mocked so this stays a pure orchestration test.
 */

const mockUpsert = jest.fn();
jest.mock("../store", () => {
  const actual = jest.requireActual("../store");
  return { ...actual, upsertSurfaces: (...a: unknown[]) => mockUpsert(...a) };
});

import { runDiscovery } from "../inventory";

beforeEach(() => {
  jest.resetAllMocks();
  mockUpsert.mockResolvedValue(2);
});

test("detects AI surfaces across files, persists them, returns a summary", async () => {
  const files = [
    { path: "src/a.ts", content: `import OpenAI from "openai";` },
    { path: "src/b.ts", content: `const k = "sk-ant-abcdefghijklmnopqrstuvwx0123";` },
  ];
  const res = await runDiscovery({ workspaceId: "w-1", target: "repo", files });

  expect(res.surfaces.map((s) => s.kind).sort()).toEqual(["ai_sdk", "api_key"]);
  expect(mockUpsert).toHaveBeenCalledWith("w-1", "repo", res.surfaces);
  expect(res.summary.total).toBe(2);
  expect(res.summary.ungoverned).toBe(2);
  expect(res.summary.byProvider).toEqual({ openai: 1, anthropic: 1 });
});

test("a clean codebase yields an empty inventory (no false positives, no write)", async () => {
  const res = await runDiscovery({
    workspaceId: "w-1",
    target: "repo",
    files: [{ path: "src/clean.ts", content: `export const greet = () => "hello";` }],
  });
  expect(res.surfaces).toEqual([]);
  expect(res.summary.total).toBe(0);
  expect(mockUpsert).toHaveBeenCalledWith("w-1", "repo", []);
});
