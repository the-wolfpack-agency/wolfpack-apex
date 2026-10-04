/** @jest-environment node */
import { NextRequest } from "next/server";

const mockBearer = jest.fn();
const mockRequireCapability = jest.fn();
const mockListWatched = jest.fn();
const mockIndex = jest.fn();
const mockDeps = jest.fn();
jest.mock("@/lib/auth/bearer-auth", () => ({ isAuthorizedBearer: (...a: unknown[]) => mockBearer(...a) }));
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/watched-repos", () => ({ listAllEnabledWatched: (...a: unknown[]) => mockListWatched(...a) }));
jest.mock("@/lib/ai-code/factory-reuse-index", () => ({
  indexReuseCorpus: (...a: unknown[]) => mockIndex(...a),
  defaultReuseIndexDeps: (...a: unknown[]) => mockDeps(...a),
}));

import { GET } from "../route";
const req = (auth?: string) =>
  new NextRequest("http://localhost/api/cron/ai-code-reuse-index", auth ? { headers: { authorization: auth } } : undefined);

const OLD = process.env.DATABASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://x";
  process.env.CRON_SECRET = "s3cret";
  mockBearer.mockReturnValue(true);
  mockDeps.mockResolvedValue({ qdrant: { url: "http://q" }, embed: jest.fn() });
  mockListWatched.mockResolvedValue([
    { workspaceId: "w1", repo: "o/a" },
    { workspaceId: "w1", repo: "o/b" },
  ]);
  mockIndex.mockResolvedValue({ indexed: 3 });
});
afterAll(() => { if (OLD === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = OLD; });

it("401 when neither cron bearer nor manage-team auth", async () => {
  mockBearer.mockReturnValue(false);
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
});

it("indexes every enabled watched repo and sums the count", async () => {
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.repos).toBe(2);
  expect(json.indexed).toBe(6); // 3 + 3
  expect(mockIndex).toHaveBeenCalledTimes(2);
  expect(mockIndex).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", repo: "o/a", limit: 500 }));
});

it("no-op (not error) when the indexer is unconfigured", async () => {
  mockDeps.mockResolvedValue(null);
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  expect((await res.json()).indexed).toBe(0);
  expect(mockIndex).not.toHaveBeenCalled();
});

it("one repo failing never aborts the sweep", async () => {
  mockIndex.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ indexed: 5 });
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  expect((await res.json()).indexed).toBe(5); // second repo still counted
});

it("no database -> clean no-op", async () => {
  delete process.env.DATABASE_URL;
  const res = await GET(req("Bearer s3cret"));
  expect((await res.json()).note).toMatch(/no database/i);
});
