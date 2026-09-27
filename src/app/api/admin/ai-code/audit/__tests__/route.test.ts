/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockVerifyChain = jest.fn();
const mockListDecisions = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ogiam/checkpoint", () => ({ verifyChain: (...a: unknown[]) => mockVerifyChain(...a) }));
jest.mock("@/lib/ogiam/queries", () => ({ listDecisions: (...a: unknown[]) => mockListDecisions(...a) }));

import { GET } from "../route";
const req = () => new NextRequest("http://localhost/api/admin/ai-code/audit?limit=50");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockVerifyChain.mockResolvedValue({ ok: true, verifiedCount: 12, legacyCount: 0, brokenAtSeq: null, headSeq: 12, headHash: "abc" });
  mockListDecisions.mockResolvedValue([{ seq: 12, rule_id: "R-MUTATION-ALLOW", effective_outcome: "allow" }]);
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req())).status).toBe(403);
});

it("returns the verified chain + entries, workspace-scoped", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockVerifyChain).toHaveBeenCalledWith("w1");
  expect(mockListDecisions).toHaveBeenCalledWith("w1", { limit: 50 });
  expect(body.verification.ok).toBe(true);
  expect(body.verification.verifiedCount).toBe(12);
  expect(body.entryCount).toBe(1);
  expect(typeof body.generatedAtIso).toBe("string");
});

it("surfaces a broken chain honestly (ok:false)", async () => {
  mockVerifyChain.mockResolvedValue({ ok: false, verifiedCount: 4, legacyCount: 0, brokenAtSeq: 5, headSeq: 8, headHash: "x" });
  const body = await (await GET(req())).json();
  expect(body.verification.ok).toBe(false);
  expect(body.verification.brokenAtSeq).toBe(5);
});
