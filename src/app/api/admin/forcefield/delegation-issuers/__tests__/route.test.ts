/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const listDelegationIssuers = jest.fn();
const registerDelegationIssuer = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/principal", () => ({
  listDelegationIssuers: (...a: unknown[]) => listDelegationIssuers(...a),
  registerDelegationIssuer: (...a: unknown[]) => registerDelegationIssuer(...a),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { GET, POST } from "@/app/api/admin/forcefield/delegation-issuers/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = (body?: unknown) =>
  new NextRequest("http://localhost/api/admin/forcefield/delegation-issuers", body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { [requireCapability, listDelegationIssuers, registerDelegationIssuer, recordAudit].forEach((m) => m.mockReset()); recordAudit.mockResolvedValue(undefined); });

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});

it("GET lists issuers WITHOUT secrets", async () => {
  requireCapability.mockResolvedValue(OK);
  listDelegationIssuers.mockResolvedValue([{ issuer: "acme", algorithm: "hs256", allowedScopes: ["/catalog"], createdAt: "2026-09-19" }]);
  const body = await (await GET(req())).json();
  expect(body.issuers[0].issuer).toBe("acme");
  expect(JSON.stringify(body)).not.toMatch(/secret/i);
  expect(listDelegationIssuers).toHaveBeenCalledWith("w1");
});

it("POST registers a valid issuer and audits (secret never in the audit)", async () => {
  requireCapability.mockResolvedValue(OK);
  const res = await POST(req({ issuer: "acme-fleet", secret: "a-strong-secret-value", allowedScopes: ["/catalog"] }));
  expect(res.status).toBe(200);
  expect(registerDelegationIssuer).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", issuer: "acme-fleet", secret: "a-strong-secret-value" }));
  const audit = recordAudit.mock.calls[0][0];
  expect(audit.action).toBe("forcefield.delegation_issuer_registered");
  expect(JSON.stringify(audit.afterState)).not.toContain("a-strong-secret-value");
});

it("POST registers an ASYMMETRIC issuer from a public key (no secret needed)", async () => {
  requireCapability.mockResolvedValue(OK);
  const res = await POST(req({ issuer: "asym-fleet", publicKey: { kty: "EC", crv: "P-256", x: "a", y: "b" }, allowedScopes: ["/catalog"] }));
  expect(res.status).toBe(200);
  expect(registerDelegationIssuer).toHaveBeenCalledWith(expect.objectContaining({ issuer: "asym-fleet", publicKey: expect.objectContaining({ kty: "EC" }) }));
});

it("POST 400s a too-short secret and never registers", async () => {
  requireCapability.mockResolvedValue(OK);
  expect((await POST(req({ issuer: "acme", secret: "short" }))).status).toBe(400);
  expect(registerDelegationIssuer).not.toHaveBeenCalled();
});

it("POST 400s a missing issuer", async () => {
  requireCapability.mockResolvedValue(OK);
  expect((await POST(req({ secret: "a-strong-secret-value" }))).status).toBe(400);
});
