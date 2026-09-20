/** @jest-environment node */
import { NextRequest } from "next/server";
const listBlockedOperatorKeys = jest.fn();
const getNetworkReputation = jest.fn();
const getEdgePolicy = jest.fn();
const trackEvent = jest.fn();
const blockOperator = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => listBlockedOperatorKeys(...a), blockOperator: (...a: unknown[]) => blockOperator(...a) }));
jest.mock("@/lib/forcefield/operator-reputation", () => ({ getNetworkReputation: (...a: unknown[]) => getNetworkReputation(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => getEdgePolicy(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

import { POST } from "@/app/api/forcefield/edge/decide/route";
const req = (body: unknown, token = "edge-token") =>
  new NextRequest("http://localhost/api/forcefield/edge/decide", {
    method: "POST", headers: { "content-type": "application/json", "x-edge-token": token }, body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.FORCEFIELD_EDGE_TOKEN = "edge-token";
  [listBlockedOperatorKeys, getNetworkReputation, getEdgePolicy, trackEvent, blockOperator, recordAudit].forEach((m) => m.mockReset());
  recordAudit.mockResolvedValue(undefined); blockOperator.mockResolvedValue(undefined);
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

describe("auto-block: stop the proven-bad agent, spare everyone else", () => {
  const enforceAuto = () => getEdgePolicy.mockResolvedValue({ mode: "enforce", autoBlock: true });

  it("auto-blocks a PROVEN-hostile agent and records it (and still emits the decision, so collection continues)", async () => {
    enforceAuto();
    const res = await POST(req({ operatorKey: "op-bad", trustBand: "hostile", proven: true }));
    const body = await res.json();
    expect(body.autoBlocked).toBe(true);
    expect(blockOperator).toHaveBeenCalledWith(expect.objectContaining({ operatorKey: "op-bad", blockedBy: "forcefield.auto" }));
    expect(trackEvent).toHaveBeenCalledWith("forcefield.operator_auto_blocked", expect.any(String), expect.any(String), expect.objectContaining({ operator: "op-bad" }));
    // enforcement never blinds observation: the decision event still fires on a block
    expect(trackEvent).toHaveBeenCalledWith("forcefield.edge_decision", expect.any(String), expect.any(String), expect.objectContaining({ action: "block" }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "operator.blocked", afterState: expect.objectContaining({ auto: true }) }));
  });

  it("does NOT auto-block an INFERRED hostile actor (could be legitimate client traffic)", async () => {
    enforceAuto();
    const body = await (await POST(req({ operatorKey: "op-maybe", trustBand: "hostile", proven: false }))).json();
    expect(body.autoBlocked).toBe(false);
    expect(blockOperator).not.toHaveBeenCalled();
  });

  it("does NOT auto-block a benign / trusted agent", async () => {
    enforceAuto();
    const body = await (await POST(req({ operatorKey: "op-good", trustBand: "trusted", proven: true }))).json();
    expect(body.autoBlocked).toBe(false);
    expect(blockOperator).not.toHaveBeenCalled();
  });

  it("does NOT auto-block when auto-block is off, even for a proven-hostile agent", async () => {
    getEdgePolicy.mockResolvedValue({ mode: "enforce", autoBlock: false });
    const body = await (await POST(req({ operatorKey: "op-bad", trustBand: "hostile", proven: true }))).json();
    expect(body.autoBlocked).toBe(false);
    expect(blockOperator).not.toHaveBeenCalled();
  });

  it("does NOT auto-block in monitor mode (shadow), even proven-hostile", async () => {
    getEdgePolicy.mockResolvedValue({ mode: "monitor", autoBlock: true });
    const body = await (await POST(req({ operatorKey: "op-bad", trustBand: "hostile", proven: true }))).json();
    expect(body.autoBlocked).toBe(false);
    expect(blockOperator).not.toHaveBeenCalled();
  });
});
