/** @jest-environment node */
import { NextRequest } from "next/server";
const mockCap = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/agent-operators", () => ({ getOperators: (...a: unknown[]) => mockGet(...a) }));
import { GET } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (q = "") => new NextRequest(`http://localhost/api/admin/operators${q}`);
beforeEach(() => { jest.clearAllMocks(); mockCap.mockResolvedValue(OK); });

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  mockCap.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
it("200 returns the workspace's operators", async () => {
  mockGet.mockResolvedValue([{ operatorKey: "op_x", threatLevel: "hostile" }]);
  const res = await GET(req("?days=7"));
  expect(res.status).toBe(200);
  expect((await res.json()).operators[0].operatorKey).toBe("op_x");
  expect(mockGet).toHaveBeenCalledWith("w1", 7);
});
