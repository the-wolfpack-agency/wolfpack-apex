/**
 * authorize() FAIL-CLOSED on unauditable. In ENFORCE mode an action that cannot
 * be written to the tamper-evident ledger must not run: authorize() retries the
 * record once, then marks the decision unauditable + wouldBlock so the PEP
 * refuses it ("no audit, no action"). The human MONITOR path is untouched - a
 * ledger failure is swallowed, never retried, never blocked.
 */

const mockRecordDecision = jest.fn();
jest.mock("@/lib/ogiam/ledger", () => ({
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));

import { authorize } from "@/lib/ogiam/authorize";
import type { OgiamPrincipal } from "@/lib/ogiam/types";

const principal: OgiamPrincipal = {
  kind: "ai_agent",
  agent: "a_1",
  onBehalfOfUserId: "a_1",
  onBehalfOfRole: "agent",
  workspaceId: "ws-1",
};
const base = {
  principal,
  tool: "search",
  capability: "*",
  isMutation: false,
  surface: "/agent",
  params: { q: "status" },
};
const recorded = { id: "d_1", seq: 7, entryHash: "h" };

beforeEach(() => mockRecordDecision.mockReset());

describe("authorize fail-closed on unauditable (enforce)", () => {
  it("a ledger write that fails both times marks the decision unauditable + wouldBlock, retried once", async () => {
    mockRecordDecision.mockResolvedValue(null);
    const d = await authorize({ ...base, mode: "enforce" });
    expect(d.unauditable).toBe(true);
    expect(d.wouldBlock).toBe(true);
    expect(d.recordedSeq).toBeUndefined();
    expect(mockRecordDecision).toHaveBeenCalledTimes(2); // initial + one retry
  });

  it("a transient failure that succeeds on retry is NOT unauditable and records the seq", async () => {
    mockRecordDecision.mockResolvedValueOnce(null).mockResolvedValueOnce(recorded);
    const d = await authorize({ ...base, mode: "enforce" });
    expect(d.unauditable).toBeFalsy();
    expect(d.recordedSeq).toBe(7);
    expect(mockRecordDecision).toHaveBeenCalledTimes(2);
  });

  it("a first-try success records and never retries", async () => {
    mockRecordDecision.mockResolvedValue(recorded);
    const d = await authorize({ ...base, mode: "enforce" });
    expect(d.unauditable).toBeFalsy();
    expect(d.recordedSeq).toBe(7);
    expect(mockRecordDecision).toHaveBeenCalledTimes(1);
  });
});

describe("authorize monitor path is untouched", () => {
  it("a ledger failure in monitor is swallowed: never unauditable, never retried", async () => {
    mockRecordDecision.mockResolvedValue(null);
    const d = await authorize({ ...base, mode: "monitor" });
    expect(d.unauditable).toBeFalsy();
    expect(mockRecordDecision).toHaveBeenCalledTimes(1); // no retry in monitor
  });
});
