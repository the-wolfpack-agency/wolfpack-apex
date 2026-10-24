/** @jest-environment node */
/**
 * Contract: GET /api/admin/security-posture/parity. 401 / 403 from the gate;
 * 200 with per-claim evidence, the live doc's drift (none), and violations when
 * an "In place" claim's evidence reads gap.
 */
import { NextRequest, NextResponse } from "next/server";
const requireCapability = jest.fn();
const collectPostureFacts = jest.fn();
const trackEvent = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/compliance/posture-evidence", () => ({ collectPostureFacts: (...a: unknown[]) => collectPostureFacts(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { GET } from "../route";

const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = () => new NextRequest("http://localhost/api/admin/security-posture/parity");
const fresh = { key: "k", proof: "p", windowDays: 1, count: 2, lastAt: new Date().toISOString(), state: "fresh" };
const facts = (over: Record<string, unknown> = {}) => ({
  platform: null,
  chain: fresh,
  isolationGuardrail: true,
  hybridTlsAssertedInCi: false,
  accessTokenTtlSeconds: 900,
  mfaEnforced: false,
  codeqlRequired: false,
  ...over,
});

beforeEach(() => [requireCapability, collectPostureFacts, trackEvent].forEach((m) => m.mockReset()));

it("401 unauthenticated", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
  expect(collectPostureFacts).not.toHaveBeenCalled();
});

it("403 without the capability", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
  expect((await GET(req())).status).toBe(403);
});

it("200: the page and the registry agree; no violations on fresh evidence; tracked", async () => {
  requireCapability.mockResolvedValue(OK);
  collectPostureFacts.mockResolvedValue(facts());
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(collectPostureFacts).toHaveBeenCalledWith("w1");
  expect(body.docDrift).toEqual([]);
  expect(body.violations).toBe(0);
  expect(body.results.find((r: { key: string }) => r.key === "audit.hash_chain").evidence).toBe("proven");
  expect(trackEvent).toHaveBeenCalledWith("assurance.posture_parity_checked", "u1", "cto", expect.objectContaining({ violations: 0, drift: 0 }));
});

it("200: an In place claim whose evidence is gap is reported as a violation", async () => {
  requireCapability.mockResolvedValue(OK);
  collectPostureFacts.mockResolvedValue(facts({ chain: { ...fresh, count: 0, lastAt: "2026-01-01T00:00:00.000Z", state: "stale" }, isolationGuardrail: false }));
  const body = await (await GET(req())).json();
  expect(body.violations).toBe(2);
  expect(body.results.filter((r: { violation: boolean }) => r.violation).map((r: { key: string }) => r.key).sort()).toEqual(["audit.hash_chain", "isolation.app_predicate"]);
});
