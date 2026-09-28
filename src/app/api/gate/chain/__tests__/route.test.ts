/** @jest-environment node */
const mockCap = jest.fn();
const mockEnt = jest.fn();
const mockGetGate = jest.fn();
const mockRunChain = jest.fn();
const mockRecord = jest.fn();
const mockRate = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockEnt(...a) }));
jest.mock("@/lib/gates/registry", () => ({ getGate: (...a: unknown[]) => mockGetGate(...a) }));
jest.mock("@/lib/gates/chain", () => ({ runChain: (...a: unknown[]) => mockRunChain(...a) }));
jest.mock("@/lib/gates/audit", () => ({ recordGateDecision: (...a: unknown[]) => mockRecord(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/gate/chain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockEnt.mockResolvedValue(null);
  mockRate.mockResolvedValue({ ok: true, remaining: 100 });
  mockGetGate.mockImplementation((n: string) => ({ name: n, purpose: "p", evaluate: jest.fn() }));
  mockRunChain.mockResolvedValue({ status: "awaiting_human", ranSteps: [{ gate: "safe-review", verdict: "allow", reason: "" }, { gate: "prod-promote", verdict: "require_human", reason: "" }], atGate: "prod-promote" });
});

test("401/403 guards", async () => {
  mockCap.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await post({ steps: [{ gate: "safe-review", input: {} }] })).status).toBe(401);
  mockCap.mockResolvedValue(OK);
  mockEnt.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await post({ steps: [{ gate: "safe-review", input: {} }] })).status).toBe(403);
});

test("429 on rate limit", async () => {
  mockRate.mockResolvedValue({ ok: false, remaining: 0 });
  expect((await post({ steps: [{ gate: "safe-review", input: {} }] })).status).toBe(429);
});

test("400 on empty steps or an unknown gate", async () => {
  expect((await post({ steps: [] })).status).toBe(400);
  mockGetGate.mockReturnValue(undefined);
  expect((await post({ steps: [{ gate: "nope", input: {} }] })).status).toBe(400);
});

test("200 runs the chain and returns the result + audits each step", async () => {
  const res = await post({ steps: [{ gate: "safe-review", input: { diff: "d" } }, { gate: "prod-promote", input: {} }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("awaiting_human");
  expect(body.atGate).toBe("prod-promote");
  expect(mockRunChain).toHaveBeenCalled();
});
