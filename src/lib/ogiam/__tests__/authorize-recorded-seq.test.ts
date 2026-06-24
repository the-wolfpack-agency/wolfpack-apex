/**
 * authorize() attaches the recorded ledger seq to the returned decision so the
 * caller can link an action OUTCOME to its decision. Asserts: recordedSeq is set
 * from recordDecision's return, and is absent when the ledger write was skipped
 * or failed (recordDecision returned null), non-breaking for legacy callers.
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

const input = {
  principal,
  tool: "search",
  capability: "*",
  isMutation: false,
  surface: "/agent",
  params: { q: "status" },
  mode: "enforce" as const,
};

beforeEach(() => mockRecordDecision.mockReset());

describe("authorize recordedSeq", () => {
  it("sets recordedSeq from the ledger return", async () => {
    mockRecordDecision.mockResolvedValue({ id: "d_1", seq: 42, entryHash: "h" });
    const decision = await authorize(input);
    expect(decision.recordedSeq).toBe(42);
  });

  it("leaves recordedSeq absent when the ledger write was skipped/failed", async () => {
    mockRecordDecision.mockResolvedValue(null);
    const decision = await authorize(input);
    expect(decision.recordedSeq).toBeUndefined();
  });
});
