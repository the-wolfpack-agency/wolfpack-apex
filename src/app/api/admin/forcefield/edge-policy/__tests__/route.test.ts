/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const getEdgePolicy = jest.fn();
const setEdgePolicy = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => getEdgePolicy(...a), setEdgePolicy: (...a: unknown[]) => setEdgePolicy(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { GET, POST } from "@/app/api/admin/forcefield/edge-policy/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = (body?: unknown) =>
  new NextRequest("http://localhost/api/admin/forcefield/edge-policy", body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { [requireCapability, getEdgePolicy, setEdgePolicy, recordAudit].forEach((m) => m.mockReset()); recordAudit.mockResolvedValue(undefined); });

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});
it("GET returns the mode", async () => {
  requireCapability.mockResolvedValue(OK);
  getEdgePolicy.mockResolvedValue({ mode: "enforce" });
  expect((await (await GET(req())).json()).mode).toBe("enforce");
});
it("POST sets enforce + audits", async () => {
  requireCapability.mockResolvedValue(OK);
  const res = await POST(req({ mode: "enforce" }));
  expect(res.status).toBe(200);
  expect(setEdgePolicy).toHaveBeenCalledWith("w1", "enforce", "u1");
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.edge_policy_set" }));
});
it("POST 400s an invalid mode", async () => {
  requireCapability.mockResolvedValue(OK);
  expect((await POST(req({ mode: "yolo" }))).status).toBe(400);
  expect(setEdgePolicy).not.toHaveBeenCalled();
});
