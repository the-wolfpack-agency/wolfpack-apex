/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockClient = jest.fn();
const mockListPRs = jest.fn();
const mockDrive = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockClient(...a), listOpenPullRequests: (...a: unknown[]) => mockListPRs(...a) }));
jest.mock("@/lib/ai-code/ci-fix-runner", () => ({ driveCiFixStep: (...a: unknown[]) => mockDrive(...a) }));

import { GET } from "../route";
const req = (auth?: string) => new NextRequest("http://localhost/api/cron/ai-code-watch", auth ? { headers: { authorization: auth } } : undefined);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  process.env.AI_CODE_WATCH_REPOS = "";
  mockClient.mockResolvedValue({ token: "t" });
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
});

it("runs on the correct cron bearer secret", async () => {
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.summary.enabled).toBe(false); // no repos enrolled
});

it("401s a wrong secret with no capability", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req("Bearer wrong"))).status).toBe(401);
  expect((await GET(req())).status).toBe(401);
});

it("allows a manual run via capability (no secret)", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(mockRequireCapability).toHaveBeenCalled();
});
