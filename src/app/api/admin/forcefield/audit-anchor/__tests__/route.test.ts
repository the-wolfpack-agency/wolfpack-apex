/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const anchorStatus = jest.fn();
const verifyExternalAnchors = jest.fn();
const publishAuditAnchor = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/audit-anchor", () => ({ anchorStatus: (...a: unknown[]) => anchorStatus(...a), verifyExternalAnchors: (...a: unknown[]) => verifyExternalAnchors(...a), publishAuditAnchor: (...a: unknown[]) => publishAuditAnchor(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { GET, POST } from "@/app/api/admin/forcefield/audit-anchor/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = () => new NextRequest("http://localhost/api/admin/forcefield/audit-anchor", { method: "POST" });
beforeEach(() => { [requireCapability, anchorStatus, verifyExternalAnchors, publishAuditAnchor, recordAudit].forEach((m) => m.mockReset()); recordAudit.mockResolvedValue(undefined); });

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});
it("GET returns status + tamper verification", async () => {
  requireCapability.mockResolvedValue(OK);
  anchorStatus.mockResolvedValue({ configured: true, count: 3, lastSeq: 42 });
  verifyExternalAnchors.mockResolvedValue({ checked: 3, matches: 3, mismatches: [], ok: true });
  const body = await (await GET(req())).json();
  expect(body.status.count).toBe(3);
  expect(body.verify.ok).toBe(true);
});
it("POST publishes + audits", async () => {
  requireCapability.mockResolvedValue(OK);
  publishAuditAnchor.mockResolvedValue({ seq: 42, entryHash: "h", delivered: true });
  const res = await POST(req());
  expect(res.status).toBe(200);
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.audit_anchor_published" }));
});
