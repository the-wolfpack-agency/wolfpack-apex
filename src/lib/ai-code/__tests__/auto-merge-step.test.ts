/** @jest-environment node */
/**
 * maybeAutoMerge: the dark-by-default effect at merge_ready. Safety properties:
 * never attempts when the flag is off, and only enables for the low-risk tail
 * (small change, gate allow, no sensitive surface, tests present). Fail-open.
 */
const mockList = jest.fn();
const mockEnable = jest.fn();
const mockContents = jest.fn();
jest.mock("@/lib/github-client", () => ({
  listChangedFiles: (...a: unknown[]) => mockList(...a),
  enableAutoMerge: (...a: unknown[]) => mockEnable(...a),
}));
jest.mock("@/lib/ai-code/ci-failure-detail", () => ({ fetchFilesContent: (...a: unknown[]) => mockContents(...a) }));

import { maybeAutoMerge } from "@/lib/ai-code/auto-merge-step";

const client = { token: "t", fetch: jest.fn() } as unknown as Parameters<typeof maybeAutoMerge>[0]["client"];
const BASE = { client, repo: "o/r", base: "main", branch: "factory/x", prNumber: 7 };
const ON = { AI_CODE_AUTO_MERGE: "on" };
const clean = (p: string) => ({ path: p, content: "export const x = 1;" });

beforeEach(() => {
  jest.clearAllMocks();
  mockEnable.mockResolvedValue({ enabled: true, reason: "native auto-merge enabled" });
});

it("flag OFF -> never attempts, no IO at all", async () => {
  const r = await maybeAutoMerge({ ...BASE, env: {} });
  expect(r.attempted).toBe(false);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockEnable).not.toHaveBeenCalled();
});

it("no PR number -> never attempts", async () => {
  const r = await maybeAutoMerge({ ...BASE, prNumber: undefined, env: ON });
  expect(r.attempted).toBe(false);
  expect(mockEnable).not.toHaveBeenCalled();
});

it("eligible low-risk tail -> enables native auto-merge", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r).toMatchObject({ attempted: true, enabled: true });
  expect(mockEnable).toHaveBeenCalledWith(client, "o/r", 7);
});

it("sensitive surface (auth) -> not attempted, keeps the human gate", async () => {
  mockList.mockResolvedValue(["src/lib/auth/require-capability.ts", "src/lib/auth/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/auth/require-capability.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/sensitive/);
  expect(mockEnable).not.toHaveBeenCalled();
});

it("no tests -> not attempted", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/test/);
});

it("gate block (introduced secret) -> not attempted", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([{ path: "src/lib/util/x.ts", content: 'const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";' }]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/allow/);
});

it("too many files -> not attempted (big diff = human authorizes)", async () => {
  mockList.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`));
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/files/);
});
