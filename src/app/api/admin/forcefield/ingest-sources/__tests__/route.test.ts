/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const listIngestSources = jest.fn();
const registerIngestSource = jest.fn();
const ingestSigningEnforced = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/ingest-signing", () => ({ listIngestSources: (...a: unknown[]) => listIngestSources(...a), registerIngestSource: (...a: unknown[]) => registerIngestSource(...a), ingestSigningEnforced: (...a: unknown[]) => ingestSigningEnforced(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { GET, POST } from "@/app/api/admin/forcefield/ingest-sources/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = (body?: unknown) => new NextRequest("http://localhost/api/admin/forcefield/ingest-sources", body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { [requireCapability, listIngestSources, registerIngestSource, ingestSigningEnforced, recordAudit].forEach((m) => m.mockReset()); recordAudit.mockResolvedValue(undefined); ingestSigningEnforced.mockReturnValue(false); listIngestSources.mockResolvedValue([]); });

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});
it("GET lists sources + whether signing is enforced", async () => {
  requireCapability.mockResolvedValue(OK);
  listIngestSources.mockResolvedValue([{ sourceId: "mkt", algorithm: "es256", createdAt: "" }]);
  ingestSigningEnforced.mockReturnValue(true);
  const body = await (await GET(req())).json();
  expect(body.sources[0].sourceId).toBe("mkt");
  expect(body.enforced).toBe(true);
});
it("POST registers an EC public key + audits", async () => {
  requireCapability.mockResolvedValue(OK);
  const res = await POST(req({ sourceId: "mkt", publicKey: { kty: "EC", crv: "P-256", x: "a", y: "b" } }));
  expect(res.status).toBe(200);
  expect(registerIngestSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "mkt" }));
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.ingest_source_registered" }));
});
it("POST 400s a non-EC key", async () => {
  requireCapability.mockResolvedValue(OK);
  expect((await POST(req({ sourceId: "mkt", publicKey: { kty: "RSA" } }))).status).toBe(400);
  expect(registerIngestSource).not.toHaveBeenCalled();
});
