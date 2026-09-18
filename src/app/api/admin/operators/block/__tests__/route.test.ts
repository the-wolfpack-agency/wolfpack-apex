/** @jest-environment node */
import { NextRequest } from "next/server";
const mockCap = jest.fn();
const mockBlock = jest.fn();
const mockUnblock = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/agent-operators", () => ({ blockOperator: (...a: unknown[]) => mockBlock(...a), unblockOperator: (...a: unknown[]) => mockUnblock(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn().mockResolvedValue(undefined) }));
import { POST } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (b: unknown) => new NextRequest("http://localhost/api/admin/operators/block", { method: "POST", body: JSON.stringify(b) });
beforeEach(() => { jest.clearAllMocks(); mockCap.mockResolvedValue(OK); });

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(403));
  expect((await POST(post({ operatorKey: "op_x" }))).status).toBe(403);
});
it("400 without an operatorKey", async () => {
  expect((await POST(post({}))).status).toBe(400);
});
it("blocks an operator (workspace-scoped)", async () => {
  const res = await POST(post({ operatorKey: "op_x", reason: "hostile" }));
  expect(res.status).toBe(200);
  expect(mockBlock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", operatorKey: "op_x", blockedBy: "u1" }));
});
it("unblocks when block:false", async () => {
  await POST(post({ operatorKey: "op_x", block: false }));
  expect(mockUnblock).toHaveBeenCalledWith("w1", "op_x");
});
