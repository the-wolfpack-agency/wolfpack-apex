/**
 * ingestAgentAction tests: builds a concise agent-action summary and feeds it to
 * the Brain ingest pipeline as an agent-audit record. Asserts the summary shape,
 * the audit tags, and graceful degradation (a thrown ingest is swallowed, never
 * propagated into dispatch).
 */

const mockIngest = jest.fn();
jest.mock("@/lib/brain/ingest", () => ({
  ingest: (...a: unknown[]) => mockIngest(...a),
}));

import {
  ingestAgentAction,
  AGENT_AUDIT_BRAIN_TAG,
} from "@/lib/agents/audit/brain-ingest";

const base = {
  workspaceId: "ws-1",
  agentId: "a_1",
  tool: "search",
  outcome: "ok",
  ruleId: "default.allow",
  resultRedacted: "all green",
};

beforeEach(() => mockIngest.mockReset());

describe("ingestAgentAction", () => {
  it("ingests a concise summary tagged as an agent-audit record", async () => {
    mockIngest.mockResolvedValue({ document_id: "doc-1", status: "indexed" });

    await ingestAgentAction(base);

    expect(mockIngest).toHaveBeenCalledTimes(1);
    const req = mockIngest.mock.calls[0][0];
    const summary = (req.buffer as Buffer).toString("utf8");
    expect(summary).toContain("Agent a_1 ran search: ok");
    expect(summary).toContain("rule default.allow");
    expect(summary).toContain("all green");
    expect(req.tags).toContain(AGENT_AUDIT_BRAIN_TAG);
    expect(req.tags).toContain("agent:a_1");
    expect(req.tags).toContain("tool:search");
    expect(req.uploadedBy).toBe("a_1");
    expect(req.contentType).toBe("text/plain");
  });

  it("omits the snippet cleanly when the result is empty", async () => {
    mockIngest.mockResolvedValue({});
    await ingestAgentAction({ ...base, resultRedacted: "" });
    const summary = (mockIngest.mock.calls[0][0].buffer as Buffer).toString("utf8");
    expect(summary).toBe("Agent a_1 ran search: ok (rule default.allow).");
  });

  it("swallows a thrown ingest (graceful degradation)", async () => {
    mockIngest.mockRejectedValue(new Error("embedder down"));
    await expect(ingestAgentAction(base)).resolves.toBeUndefined();
  });
});
