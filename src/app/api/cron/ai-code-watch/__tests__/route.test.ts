/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockClient = jest.fn();
const mockListPRs = jest.fn();
const mockDrive = jest.fn();
const mockListAll = jest.fn();
const mockEntitle = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockClient(...a), listOpenPullRequests: (...a: unknown[]) => mockListPRs(...a) }));
jest.mock("@/lib/tenancy/entitlements", () => ({ resolveEntitlement: (...a: unknown[]) => mockEntitle(...a) }));
jest.mock("@/lib/ai-code/ci-fix-runner", () => ({ driveCiFixStep: (...a: unknown[]) => mockDrive(...a) }));
jest.mock("@/lib/ai-code/watched-repos", () => ({
  ...jest.requireActual("@/lib/ai-code/watched-repos"),
  listAllEnabledWatched: (...a: unknown[]) => mockListAll(...a),
}));

import { GET } from "../route";
const req = (auth?: string) => new NextRequest("http://localhost/api/cron/ai-code-watch", auth ? { headers: { authorization: auth } } : undefined);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  delete process.env.AI_CODE_WATCH_REPOS;
  mockClient.mockResolvedValue({ token: "t" });
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockListAll.mockResolvedValue([]);
  mockEntitle.mockResolvedValue(true);
  mockListPRs.mockResolvedValue([]);
});

it("runs on the correct cron bearer secret", async () => {
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.summary.enabled).toBe(false);
});

it("401s a wrong secret with no capability", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req("Bearer wrong"))).status).toBe(401);
  expect((await GET(req())).status).toBe(401);
});

it("drives DB-enrolled targets with their own workspace", async () => {
  mockListAll.mockResolvedValue([{ workspaceId: "w1", repo: "o/r" }]);
  mockListPRs.mockResolvedValue([{ number: 5, headRef: "factory/feat", baseRef: "main" }]);
  mockDrive.mockResolvedValue({ body: { decision: { action: "merge_ready" }, terminal: true } });
  const res = await GET(req("Bearer s3cret"));
  const body = await res.json();
  expect(body.summary.driven[0]).toMatchObject({ workspaceId: "w1", repo: "o/r", pr: 5, terminal: true });
  expect(mockDrive).toHaveBeenCalledWith(expect.objectContaining({ repo: "o/r", workspaceId: "w1", branch: "factory/feat" }));
});

it("skips a workspace lacking the secure_agent entitlement", async () => {
  mockListAll.mockResolvedValue([{ workspaceId: "w-unentitled", repo: "o/r" }]);
  mockEntitle.mockResolvedValue(false);
  const res = await GET(req("Bearer s3cret"));
  const body = await res.json();
  expect(body.summary.driven).toEqual([]);
  expect(mockListPRs).not.toHaveBeenCalled();
});
