/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockRunGate = jest.fn();
const mockGetGate = jest.fn();
const mockRecord = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/gates/registry", () => ({ getGate: (...a: unknown[]) => mockGetGate(...a) }));
jest.mock("@/lib/gates/run-gate", () => ({ runGate: (...a: unknown[]) => mockRunGate(...a) }));
jest.mock("@/lib/gates/audit", () => ({ recordGateDecision: (...a: unknown[]) => mockRecord(...a) }));
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: jest.fn() }) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (gate: string, body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/gate/" + gate, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ gate }) },
  );

const DEF = { name: "safe-review", entitlement: "secure_agent", purpose: "p", evaluate: jest.fn() };
const ALLOW_RESULT = {
  verdict: "allow", findings: [], reason: "clean",
  transparency: { checksRun: ["security-scan"], dataSeen: "diff", modelInvoked: null, frameworksApplied: ["SOC2"], explanation: "clean" },
  output: { diff: "d" }, audit: { gate: "safe-review", verdict: "allow", ruleId: "R", reason: "clean", workspaceId: "w1", actorId: "u1" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(null);
  mockGetGate.mockReturnValue(DEF);
  mockRunGate.mockResolvedValue(ALLOW_RESULT);
  mockRecord.mockResolvedValue({ recordedSeq: 42 });
});

test("401 when the capability check fails", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await post("safe-review", { input: { diff: "d" } })).status).toBe(401);
});

test("403 when the workspace lacks the gate's entitlement", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await post("safe-review", { input: { diff: "d" } })).status).toBe(403);
});

test("404 for an unknown gate", async () => {
  mockGetGate.mockReturnValue(undefined);
  const res = await post("does-not-exist", { input: { diff: "d" } });
  expect(res.status).toBe(404);
});

test("400 when input is missing", async () => {
  expect((await post("safe-review", { policy: {} })).status).toBe(400);
});

test("200 runs the gate and returns the verdict, transparency, and the hash-chained ledger seq", async () => {
  const res = await post("safe-review", { input: { diff: "d" }, policy: { frameworks: ["SOC2"], allowModelData: "none" } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.verdict).toBe("allow");
  expect(body.transparency.checksRun).toContain("security-scan");
  expect(body.transparency.modelInvoked).toBeNull();
  expect(body.recordedSeq).toBe(42);          // decision is on the hash-chained ledger
  expect(body.output).toEqual({ diff: "d" }); // allow carries the change forward
  // the gate ran under the client's parsed policy
  expect(mockRunGate).toHaveBeenCalledWith(DEF, { diff: "d" }, expect.objectContaining({ workspaceId: "w1", actorId: "u1", policy: expect.objectContaining({ frameworks: ["SOC2"], allowModelData: "none" }) }));
});

test("a deny is a healthy 200 with verdict:deny (the gate ran; HTTP reflects that, not the verdict)", async () => {
  mockRunGate.mockResolvedValue({ ...ALLOW_RESULT, verdict: "deny", output: undefined, reason: "secret", findings: [{ id: "security", severity: "critical", detail: "secret" }] });
  const res = await post("safe-review", { input: { diff: "d" } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.verdict).toBe("deny");
  expect(body.output).toBeUndefined();
});

test("defaults to a no-model policy when none is supplied (safe by default)", async () => {
  await post("safe-review", { input: { diff: "d" } });
  expect(mockRunGate).toHaveBeenCalledWith(DEF, { diff: "d" }, expect.objectContaining({ policy: expect.objectContaining({ allowModelData: "none" }) }));
});
