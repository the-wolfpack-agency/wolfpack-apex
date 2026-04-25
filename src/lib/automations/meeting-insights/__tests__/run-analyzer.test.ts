/**
 * Tests for run-analyzer — the orchestrator that wires the analyzer
 * pipeline to persistence + triple-write.
 *
 * Mocks: getMessage, listAttachmentsForMessage, analyzeMessage, upsertAnalysis,
 * fanoutAnalysisToSecondaries.
 */

const mockGetMessage = jest.fn();
const mockListAttachments = jest.fn();
const mockAnalyzeMessage = jest.fn();
const mockUpsertAnalysis = jest.fn();
const mockFanout = jest.fn();

jest.mock("../messages-repo", () => ({
  getMessage: (...a: unknown[]) => mockGetMessage(...a),
  listAttachmentsForMessage: (...a: unknown[]) => mockListAttachments(...a),
}));

jest.mock("../analyses-repo", () => ({
  upsertAnalysis: (...a: unknown[]) => mockUpsertAnalysis(...a),
  getLatestAnalysisForMessage: jest.fn(),
}));

jest.mock("../analyzer", () => ({
  analyzeMessage: (...a: unknown[]) => mockAnalyzeMessage(...a),
}));

jest.mock("../triple-write", () => ({
  fanoutAnalysisToSecondaries: (...a: unknown[]) => mockFanout(...a),
}));

import { runAnalyzer, buildSummaryText } from "../run-analyzer";
import { ANALYZER_VERSION } from "../analyzer/types";

beforeEach(() => {
  jest.clearAllMocks();
});

const MSG = {
  id: "m-1",
  feed_id: "f-1",
  source_message_id: "src-1",
  artifact_id: "a-1",
  subject: "Weekly",
  from_address: "alice@x",
  from_name: "Alice",
  to_addresses: [],
  cc_addresses: [],
  received_at: "2026-04-01T00:00:00Z",
  body_text: "we shipped pricing v2",
  body_html: null,
  has_attachments: false,
  created_at: "2026-04-01T00:00:00Z",
};

describe("runAnalyzer", () => {
  it("returns message_not_found when getMessage returns null", async () => {
    mockGetMessage.mockResolvedValueOnce(null);
    const out = await runAnalyzer({ feed_id: "f-1", message_id: "m-1" });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("message_not_found");
  });

  it("persists a success row and triggers fanout", async () => {
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockListAttachments.mockResolvedValueOnce([]);
    mockAnalyzeMessage.mockResolvedValueOnce({
      status: "success",
      analysis: {
        decisions: [{ summary: "Ship" }],
        action_items: [],
        topics: ["pricing"],
        attendees: [],
        blockers: [],
        next_steps: [],
      },
      raw_llm_response: "{}",
      model: "claude-haiku-4-5",
      tokens_used: 100,
    });
    mockUpsertAnalysis.mockResolvedValueOnce({
      id: "an-1",
      message_id: "m-1",
      analyzer_version: ANALYZER_VERSION,
      analyzed_at: "2026-04-01T00:01:00Z",
      decisions: [{ summary: "Ship" }],
      action_items: [],
      topics: ["pricing"],
      attendees: [],
      blockers: [],
      next_steps: [],
      raw_llm_response: "{}",
      model: "claude-haiku-4-5",
      tokens_used: 100,
      status: "success",
      error_detail: null,
      created_at: "2026-04-01T00:01:00Z",
    });

    const out = await runAnalyzer({ feed_id: "f-1", message_id: "m-1" });
    expect(out.ok).toBe(true);
    expect(out.record?.status).toBe("success");
    expect(mockFanout).toHaveBeenCalledTimes(1);
    expect(mockFanout.mock.calls[0][0]).toMatchObject({
      message_id: "m-1",
      feed_id: "f-1",
      topics: ["pricing"],
    });
  });

  it("persists an error row and skips fanout", async () => {
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockListAttachments.mockResolvedValueOnce([]);
    mockAnalyzeMessage.mockResolvedValueOnce({
      status: "error",
      analysis: {
        decisions: [],
        action_items: [],
        topics: [],
        attendees: [],
        blockers: [],
        next_steps: [],
      },
      error_detail: "ANTHROPIC_API_KEY not set",
    });
    mockUpsertAnalysis.mockResolvedValueOnce({
      id: "an-2",
      message_id: "m-1",
      analyzer_version: ANALYZER_VERSION,
      analyzed_at: "2026-04-01T00:01:00Z",
      decisions: [],
      action_items: [],
      topics: [],
      attendees: [],
      blockers: [],
      next_steps: [],
      raw_llm_response: null,
      model: null,
      tokens_used: null,
      status: "error",
      error_detail: "ANTHROPIC_API_KEY not set",
      created_at: "2026-04-01T00:01:00Z",
    });

    const out = await runAnalyzer({ feed_id: "f-1", message_id: "m-1" });
    expect(out.ok).toBe(false);
    expect(out.record?.status).toBe("error");
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it("survives upsert failure with a clean error", async () => {
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockListAttachments.mockResolvedValueOnce([]);
    mockAnalyzeMessage.mockResolvedValueOnce({
      status: "success",
      analysis: {
        decisions: [],
        action_items: [],
        topics: [],
        attendees: [],
        blockers: [],
        next_steps: [],
      },
    });
    mockUpsertAnalysis.mockRejectedValueOnce(new Error("db down"));

    const out = await runAnalyzer({ feed_id: "f-1", message_id: "m-1" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("upsert_failed");
  });
});

describe("buildSummaryText", () => {
  it("composes a multi-section string", () => {
    const txt = buildSummaryText({
      id: "an-1",
      message_id: "m-1",
      analyzer_version: "v",
      analyzed_at: "",
      summary: "Ship v2",
      decisions: [{ summary: "Ship v2" }],
      action_items: [{ description: "Do thing" }],
      topics: ["pricing", "launch"],
      attendees: [],
      blockers: [{ description: "Legal sign-off needed" }],
      next_steps: [],
      raw_llm_response: null,
      model: null,
      tokens_used: null,
      status: "success",
      error_detail: null,
      created_at: "",
    });
    expect(txt).toContain("Topics: pricing, launch");
    expect(txt).toContain("Decisions: Ship v2");
    expect(txt).toContain("Action items: Do thing");
    expect(txt).toContain("Blockers: Legal sign-off needed");
  });

  it("returns empty string for empty analysis", () => {
    expect(
      buildSummaryText({
        id: "x",
        message_id: "y",
        analyzer_version: "v",
        analyzed_at: "",
        summary: null,
        decisions: [],
        action_items: [],
        topics: [],
        attendees: [],
        blockers: [],
        next_steps: [],
        raw_llm_response: null,
        model: null,
        tokens_used: null,
        status: "success",
        error_detail: null,
        created_at: "",
      }),
    ).toBe("");
  });
});
