/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const getReputationOptIn = jest.fn();
const setReputationOptIn = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/operator-reputation", () => ({ getReputationOptIn: (...a: unknown[]) => getReputationOptIn(...a), setReputationOptIn: (...a: unknown[]) => setReputationOptIn(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { GET, POST } from "@/app/api/admin/forcefield/reputation-optin/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = (body?: unknown) => new NextRequest("http://localhost/api/admin/forcefield/reputation-optin", body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { [requireCapability, getReputationOptIn, setReputationOptIn, recordAudit].forEach((m) => m.mockReset()); recordAudit.mockResolvedValue(undefined); });

describe("reputation opt-in route", () => {
  it("403 when not capable", async () => {
    requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
    expect((await GET(req())).status).toBe(403);
  });
  it("GET returns the workspace's opt-in", async () => {
    requireCapability.mockResolvedValue(OK);
    getReputationOptIn.mockResolvedValue({ contribute: true, consume: false });
    const body = await (await GET(req())).json();
    expect(body.optIn).toEqual({ contribute: true, consume: false });
    expect(getReputationOptIn).toHaveBeenCalledWith("w1");
  });
  it("POST sets opt-in (coercing to booleans) and audits", async () => {
    requireCapability.mockResolvedValue(OK);
    const res = await POST(req({ contribute: true, consume: true }));
    expect(res.status).toBe(200);
    expect(setReputationOptIn).toHaveBeenCalledWith("w1", { contribute: true, consume: true }, "u1");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.reputation_optin_set", resourceId: "w1" }));
  });
});
