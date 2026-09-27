/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockAssess = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/readiness", () => ({ assessReadiness: (...a: unknown[]) => mockAssess(...a) }));

import { GET } from "../route";
const req = (qs: string) => new NextRequest(`http://localhost/api/admin/ai-code/readiness?${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockAssess.mockResolvedValue({ checks: [], overall: "pass", ready: true, fullyReady: true });
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req("repo=o/r"))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req("repo=o/r"))).status).toBe(403);
});

it("400 on missing or malformed repo", async () => {
  expect((await GET(req(""))).status).toBe(400);
  expect((await GET(req("repo=not a repo"))).status).toBe(400);
});

it("returns the readiness report, workspace-scoped, passing the install URL through", async () => {
  process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL = "https://github.com/apps/agentgate-ai/installations/new";
  mockAssess.mockResolvedValue({ checks: [{ id: "pr-capability", label: "Automatic pull requests", status: "warn", detail: "..." }], overall: "warn", ready: true, fullyReady: false });
  const res = await GET(req("repo=o/r"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockAssess).toHaveBeenCalledWith("o/r", "w1", "https://github.com/apps/agentgate-ai/installations/new");
  expect(body.readiness.overall).toBe("warn");
  expect(body.readiness.ready).toBe(true);
  delete process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL;
});
