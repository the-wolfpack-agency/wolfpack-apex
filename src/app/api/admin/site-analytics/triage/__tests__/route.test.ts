/** @jest-environment node */
import { NextRequest } from "next/server";

const requireCapability = jest.fn();
const setFindingTriage = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/site-finding-triage", () => ({
  setFindingTriage: (...a: unknown[]) => setFindingTriage(...a),
  isTriageStatus: (v: unknown) => ["new", "acknowledged", "escalated", "dismissed"].includes(v as string),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a), extractRequestMetadata: () => ({}) }));

import { POST } from "@/app/api/admin/site-analytics/triage/route";

const OK_USER = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" } };
const req = (body: unknown) => new NextRequest("http://localhost/api/admin/site-analytics/triage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { requireCapability.mockReset(); setFindingTriage.mockReset(); recordAudit.mockReset(); });

describe("POST /api/admin/site-analytics/triage", () => {
  it("sets the triage state and writes an audit entry", async () => {
    requireCapability.mockResolvedValueOnce(OK_USER);
    const res = await POST(req({ findingKey: "fp1", status: "escalated", note: "real" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, status: "escalated" });
    expect(setFindingTriage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", findingKey: "fp1", status: "escalated", updatedBy: "u1" }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "site_analytics.finding_triaged", resourceId: "fp1" }));
  });

  it("gates on the analytics.triage capability", async () => {
    requireCapability.mockResolvedValueOnce({ ok: false, response: new Response("forbidden", { status: 403 }) });
    const res = await POST(req({ findingKey: "fp1", status: "dismissed" }));
    expect(res.status).toBe(403);
    expect(setFindingTriage).not.toHaveBeenCalled();
    expect(requireCapability).toHaveBeenCalledWith(expect.anything(), "analytics.triage");
  });

  it("rejects an invalid status or missing key with 400 (not 500)", async () => {
    requireCapability.mockResolvedValue(OK_USER);
    expect((await POST(req({ findingKey: "fp1", status: "bogus" }))).status).toBe(400);
    expect((await POST(req({ status: "escalated" }))).status).toBe(400);
    expect(setFindingTriage).not.toHaveBeenCalled();
  });
});
