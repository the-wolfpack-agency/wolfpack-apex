/** @jest-environment node */
import { NextRequest } from "next/server";
const requireCapability = jest.fn();
const getEdgePolicy = jest.fn();
const listDelegationIssuers = jest.fn();
const getReputationOptIn = jest.fn();
const listCanariesForDisplay = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => getEdgePolicy(...a) }));
jest.mock("@/lib/forcefield/principal", () => ({ ...jest.requireActual("@/lib/forcefield/principal"), listDelegationIssuers: (...a: unknown[]) => listDelegationIssuers(...a) }));
jest.mock("@/lib/forcefield/operator-reputation", () => ({ getReputationOptIn: (...a: unknown[]) => getReputationOptIn(...a) }));
jest.mock("@/lib/forcefield/canary-store", () => ({ listCanariesForDisplay: (...a: unknown[]) => listCanariesForDisplay(...a) }));
// the adversarial suite is the REAL one (drives real defenses) - not mocked.

import { GET } from "@/app/api/admin/forcefield/assurance/route";
const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = () => new NextRequest("http://localhost/api/admin/forcefield/assurance");

beforeEach(() => {
  [requireCapability, getEdgePolicy, listDelegationIssuers, getReputationOptIn, listCanariesForDisplay].forEach((m) => m.mockReset());
  getEdgePolicy.mockResolvedValue({ mode: "enforce", autoBlock: true });
  listDelegationIssuers.mockResolvedValue([{ issuer: "a", algorithm: "es256", allowedScopes: [], createdAt: "" }]);
  getReputationOptIn.mockResolvedValue({ contribute: false, consume: true });
  listCanariesForDisplay.mockResolvedValue([{}, {}]);
});

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("", { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});

it("returns the assurance report + the adversarial self-test results, all defended", async () => {
  requireCapability.mockResolvedValue(OK);
  const body = await (await GET(req())).json();
  expect(body.assurance.total).toBeGreaterThan(5);
  expect(body.assurance.score).toBeGreaterThan(0);
  // the state we fed makes inline enforcement active
  expect(body.assurance.controls.find((c: { id: string }) => c.id === "enforce.inline").status).toBe("active");
  // the real self-attack suite must fully defend
  expect(body.adversarial.allDefended).toBe(true);
  expect(body.adversarial.total).toBeGreaterThan(5);
});
