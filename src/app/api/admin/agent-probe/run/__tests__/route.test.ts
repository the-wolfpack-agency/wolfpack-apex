/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/agent-probe/run. The router + runner are mocked.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockRun = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/ai/router", () => ({ getAIClient: () => ({ complete: jest.fn() }) }));
jest.mock("@/lib/agent-probe-runner", () => {
  const actual = jest.requireActual("@/lib/agent-probe-runner");
  return { ...actual, runProbeAgainstTarget: (...a: unknown[]) => mockRun(...a) };
});
jest.mock("@/lib/agent-operators", () => ({ recordSighting: jest.fn().mockResolvedValue("op_x") }));
import { ProbeTargetNotAllowedError } from "@/lib/agent-probe-runner";

import { POST } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (b: unknown) => new NextRequest("http://localhost/api/admin/agent-probe/run", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => { jest.clearAllMocks(); mockCap.mockResolvedValue(OK); });

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(401));
  expect((await POST(post({}))).status).toBe(401);
  mockCap.mockResolvedValue(deny(403));
  expect((await POST(post({}))).status).toBe(403);
});

it("400 when the target is not on the allowlist", async () => {
  mockRun.mockRejectedValue(new ProbeTargetNotAllowedError("https://evil.com"));
  const res = await POST(post({ targetBase: "https://evil.com" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("target_not_allowed");
});

it("200 returns the behavior report + operator dossier", async () => {
  mockRun.mockResolvedValue({
    report: { journey: { behaviorClass: "vuln_scanner", confidence: "proven" } },
    dossier: { threatLevel: "hostile", confidence: "proven", operatorKey: "op_x" },
    sighting: { surface: "ogiam.com", at: "t", journey: {}, scaffolding: {}, tools: {} },
    targetHost: "ogiam.com",
  });
  const res = await POST(post({ tier: "standard", goal: "find admin", targetBase: "https://ogiam.com" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.report.journey.behaviorClass).toBe("vuln_scanner");
  expect(body.dossier.threatLevel).toBe("hostile");
  // The runner was called with the router client + the chosen tier.
  expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ tier: "standard", targetBase: "https://ogiam.com" }));
});
