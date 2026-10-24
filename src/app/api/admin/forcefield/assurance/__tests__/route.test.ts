/** @jest-environment node */
/**
 * Contract: GET /api/admin/forcefield/assurance.
 * 401 / 403 from the capability gate; 200 with an evidence-backed report whose
 * statuses follow the evidence (fresh -> active, stale -> gap, error -> unknown),
 * regardless of an armed config.
 */
import { NextRequest, NextResponse } from "next/server";
const requireCapability = jest.fn();
const getEdgePolicy = jest.fn();
const listDelegationIssuers = jest.fn();
const getReputationOptIn = jest.fn();
const listIngestSources = jest.fn();
const collectAssuranceEvidence = jest.fn();
const trackEvent = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => getEdgePolicy(...a) }));
jest.mock("@/lib/forcefield/principal", () => ({ ...jest.requireActual("@/lib/forcefield/principal"), listDelegationIssuers: (...a: unknown[]) => listDelegationIssuers(...a) }));
jest.mock("@/lib/forcefield/operator-reputation", () => ({ getReputationOptIn: (...a: unknown[]) => getReputationOptIn(...a) }));
jest.mock("@/lib/forcefield/ingest-signing", () => ({ listIngestSources: (...a: unknown[]) => listIngestSources(...a), ingestSigningEnforced: () => false }));
jest.mock("@/lib/forcefield/assurance-evidence", () => ({ ...jest.requireActual("@/lib/forcefield/assurance-evidence"), collectAssuranceEvidence: (...a: unknown[]) => collectAssuranceEvidence(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
// the adversarial suite is the REAL one (drives real defenses) - not mocked.

import { GET } from "@/app/api/admin/forcefield/assurance/route";
import { ASSURANCE_EVIDENCE_KEYS } from "@/lib/forcefield/assurance";

const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = () => new NextRequest("http://localhost/api/admin/forcefield/assurance");

const evidence = (state: "fresh" | "stale" | "error") => ({
  probes: Object.fromEntries(
    ASSURANCE_EVIDENCE_KEYS.map((k) => [
      k,
      {
        key: k,
        proof: k,
        windowDays: 7,
        count: state === "fresh" ? 2 : 0,
        lastAt: state === "fresh" ? new Date().toISOString() : state === "stale" ? "2026-01-01T00:00:00.000Z" : null,
        state,
        ...(state === "error" ? { error: "relation does not exist" } : {}),
      },
    ]),
  ),
  tripwire: state === "error" ? null : { reachable: 1, tripped: 1, unreachableKinds: [] },
});

type Ctl = { id: string; status: string; evidence: unknown[] };
const status = (body: { assurance: { controls: Ctl[] } }, id: string) => body.assurance.controls.find((c) => c.id === id)?.status;

beforeEach(() => {
  [requireCapability, getEdgePolicy, listDelegationIssuers, getReputationOptIn, listIngestSources, collectAssuranceEvidence, trackEvent].forEach((m) => m.mockReset());
  // Fully armed CONFIG - must never be enough on its own.
  getEdgePolicy.mockResolvedValue({ mode: "enforce", autoBlock: true });
  listDelegationIssuers.mockResolvedValue([{ issuer: "a", algorithm: "es256", allowedScopes: [], createdAt: "" }]);
  getReputationOptIn.mockResolvedValue({ contribute: false, consume: true });
  listIngestSources.mockResolvedValue([]);
});

it("401 when unauthenticated", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
  expect(collectAssuranceEvidence).not.toHaveBeenCalled();
});

it("403 when not capable", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});

it("200: fresh evidence -> active, each control carries its evidence, report is tracked", async () => {
  requireCapability.mockResolvedValue(OK);
  collectAssuranceEvidence.mockResolvedValue(evidence("fresh"));
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(collectAssuranceEvidence).toHaveBeenCalledWith("w1");
  expect(status(body, "enforce.inline")).toBe("active");
  expect(status(body, "verify.replay")).toBe("active"); // real replay scenario passed + fresh store
  expect(status(body, "defense.deterministic_gate")).toBe("active"); // real injection scenario
  expect(body.assurance.controls.find((c: Ctl) => c.id === "enforce.inline").evidence[0].key).toBe("ff.inline_block");
  // only PQ transport is unmeasured here (PROD_DOMAIN unset in tests)
  expect(body.assurance.controls.filter((c: Ctl) => c.status === "unknown").map((c: Ctl) => c.id)).toEqual(
    process.env.PROD_DOMAIN ? [] : ["crypto.pq_transport"],
  );
  // the real self-attack suite must fully defend
  expect(body.adversarial.allDefended).toBe(true);
  expect(body.breaches.total).toBe(10);
  expect(body.lowAndSlow.total).toBeGreaterThan(0);
  expect(trackEvent).toHaveBeenCalledWith("assurance.report_computed", "u1", "cto", expect.objectContaining({ total: body.assurance.total, score: body.assurance.score }));
});

it("200: stale evidence with an armed config -> gap, not active", async () => {
  requireCapability.mockResolvedValue(OK);
  collectAssuranceEvidence.mockResolvedValue(evidence("stale"));
  const body = await (await GET(req())).json();
  expect(status(body, "enforce.inline")).toBe("gap");
  expect(status(body, "network.reputation")).toBe("gap");
  expect(status(body, "audit.hash_chain")).toBe("gap");
  expect(body.assurance.activeCount).toBe(1); // only the in-request injection sample
});

it("200: query errors -> unknown, never active", async () => {
  requireCapability.mockResolvedValue(OK);
  collectAssuranceEvidence.mockResolvedValue(evidence("error"));
  const body = await (await GET(req())).json();
  expect(status(body, "enforce.inline")).toBe("unknown");
  expect(status(body, "detect.tripwire")).toBe("unknown");
  expect(body.assurance.unknownCount).toBeGreaterThan(5);
});

it("200: a config read that throws is unknown, not a passing default", async () => {
  requireCapability.mockResolvedValue(OK);
  collectAssuranceEvidence.mockResolvedValue(evidence("fresh"));
  listDelegationIssuers.mockRejectedValue(new Error("db down"));
  getReputationOptIn.mockRejectedValue(new Error("db down"));
  const body = await (await GET(req())).json();
  expect(status(body, "verify.principal")).toBe("unknown");
  expect(status(body, "network.reputation")).toBe("unknown");
});
