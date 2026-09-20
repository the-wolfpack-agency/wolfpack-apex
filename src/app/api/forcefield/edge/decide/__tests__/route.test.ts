/** @jest-environment node */
import { NextRequest } from "next/server";
const listBlockedOperatorKeys = jest.fn();
const getNetworkReputation = jest.fn();
const getEdgePolicy = jest.fn();
const trackEvent = jest.fn();
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => listBlockedOperatorKeys(...a) }));
jest.mock("@/lib/forcefield/operator-reputation", () => ({ getNetworkReputation: (...a: unknown[]) => getNetworkReputation(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => getEdgePolicy(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { POST } from "@/app/api/forcefield/edge/decide/route";
const req = (body: unknown, token = "edge-token") =>
  new NextRequest("http://localhost/api/forcefield/edge/decide", {
    method: "POST", headers: { "content-type": "application/json", "x-edge-token": token }, body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.FORCEFIELD_EDGE_TOKEN = "edge-token";
  [listBlockedOperatorKeys, getNetworkReputation, getEdgePolicy, trackEvent].forEach((m) => m.mockReset());
  listBlockedOperatorKeys.mockResolvedValue(new Set());
  getNetworkReputation.mockResolvedValue({});
  getEdgePolicy.mockResolvedValue({ mode: "enforce" });
});

it("503 when the edge token is not configured", async () => {
  delete process.env.FORCEFIELD_EDGE_TOKEN;
  expect((await POST(req({ operatorKey: "op1" }))).status).toBe(503);
});

it("401 on a bad edge token", async () => {
  expect((await POST(req({ operatorKey: "op1" }, "nope"))).status).toBe(401);
});

it("400 without an operatorKey", async () => {
  expect((await POST(req({}))).status).toBe(400);
});

it("blocks a blocklisted operator (server-authoritative) and records the decision", async () => {
  listBlockedOperatorKeys.mockResolvedValue(new Set(["op-bad"]));
  const body = await (await POST(req({ operatorKey: "op-bad", trustBand: "trusted" }))).json();
  expect(body.decision.action).toBe("block");
  expect(body.decision.ruleId).toBe("operator_blocklisted");
  expect(trackEvent).toHaveBeenCalledWith("forcefield.edge_decision", expect.any(String), expect.any(String), expect.objectContaining({ action: "block", rule: "operator_blocklisted" }));
});

it("blocks an operator known hostile on the reputation network", async () => {
  getNetworkReputation.mockResolvedValue({ "op-x": { operatorKey: "op-x", otherWorkspaces: 4, severity: "hostile" } });
  const body = await (await POST(req({ operatorKey: "op-x", trustBand: "caution" }))).json();
  expect(body.decision.ruleId).toBe("network_hostile");
});

it("monitor mode returns action=monitor even for a hostile operator", async () => {
  getEdgePolicy.mockResolvedValue({ mode: "monitor" });
  const body = await (await POST(req({ operatorKey: "op1", trustBand: "hostile" }))).json();
  expect(body.decision.intended).toBe("block");
  expect(body.decision.action).toBe("monitor");
  expect(body.decision.enforced).toBe(false);
});
