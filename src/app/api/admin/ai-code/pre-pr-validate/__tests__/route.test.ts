/** @jest-environment node */
const mockCap = jest.fn();
const mockEnt = jest.fn();
const mockClient = jest.fn();
const mockPush = jest.fn();
const mockGetGate = jest.fn();
const mockRunGate = jest.fn();
const mockRecord = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockEnt(...a) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockClient(...a) }));
jest.mock("@/lib/ai-code/pre-pr-validation", () => ({ pushValidationBranch: (...a: unknown[]) => mockPush(...a) }));
jest.mock("@/lib/gates/registry", () => ({ getGate: (...a: unknown[]) => mockGetGate(...a) }));
jest.mock("@/lib/gates/run-gate", () => ({ runGate: (...a: unknown[]) => mockRunGate(...a) }));
jest.mock("@/lib/gates/audit", () => ({ recordGateDecision: (...a: unknown[]) => mockRecord(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/admin/ai-code/pre-pr-validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const valid = { repo: "o/r", ref: "feat-x", changes: [{ path: "src/x.ts", content: "export const x=1;" }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockEnt.mockResolvedValue(null);
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockPush.mockResolvedValue("factory-validate/feat-x-abc123");
  mockGetGate.mockReturnValue({ name: "pre-pr-validate", evaluate: jest.fn() });
  mockRunGate.mockResolvedValue({ verdict: "allow", reason: "tests pass", output: { status: "pass", failing: [] }, findings: [], transparency: {}, audit: {} });
  mockRecord.mockResolvedValue({ recordedSeq: 7 });
});

test("401/403 guards", async () => {
  mockCap.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await post(valid)).status).toBe(401);
  mockCap.mockResolvedValue(OK);
  mockEnt.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await post(valid)).status).toBe(403);
});

test("400 on bad repo / missing ref / empty changes", async () => {
  expect((await post({ ...valid, repo: "bad" })).status).toBe(400);
  expect((await post({ ...valid, ref: "" })).status).toBe(400);
  expect((await post({ ...valid, changes: [] })).status).toBe(400);
});

test("200: pushes the validation branch, runs the gate, returns the verdict (validated -> open PR)", async () => {
  const res = await post(valid);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockPush).toHaveBeenCalledWith(expect.anything(), "o/r", valid.changes, "main", "feat-x");
  expect(body.branch).toBe("factory-validate/feat-x-abc123");
  expect(body.verdict).toBe("allow"); // authored tests passed -> caller opens the real PR
  expect(body.recordedSeq).toBe(7);   // decision on the ledger
});

test("200: a self-inconsistent change -> require_human (no looping PR)", async () => {
  mockRunGate.mockResolvedValue({ verdict: "require_human", reason: "authored tests FAIL", output: { status: "fail", failing: ["factory-validate"] }, findings: [], transparency: {}, audit: {} });
  const body = await (await post(valid)).json();
  expect(body.verdict).toBe("require_human");
  expect(body.output.status).toBe("fail");
});
