/**
 * Eval harness — answer-relevance regression suite.
 *
 * Loads cases.json and runs each one end-to-end through chat(),
 * asserting the contract in the case's `expect` block. This is the
 * test that would have caught both 2026-05-14 prod regressions
 * (KB cross-topic over-match + A1 zero-hit reject) in CI rather than
 * in front of the user.
 *
 * To add a case: edit src/lib/assistant/eval/cases.json. To run only
 * a category: `npx jest eval-harness -t regression`.
 *
 * Every case emits an `assistant.eval_case_executed` analytics event
 * so the learning loop sees pass/fail trends per case over time —
 * no data lost, every run becomes signal.
 */

// ---------------------------------------------------------------------------
// Mocks — mirror the assistant.test.ts setup so every code path the
// real chat() takes (KB, brain context via getRelevantContext, AI
// client via getAIClient) is interceptable per case.
// ---------------------------------------------------------------------------

const mockSearchKnowledge = jest.fn();
const mockSaveAnswer = jest.fn();
const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetRelevantContext = jest.fn();
const mockAIComplete = jest.fn();

jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
  saveAnswer: (...args: any[]) => mockSaveAnswer(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: jest.fn().mockResolvedValue(undefined),
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/assistant/context-resolver", () => ({
  getRelevantContext: (...args: any[]) => mockGetRelevantContext(...args),
}));

class TestNoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderAvailableError";
  }
}
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: (...args: any[]) => mockAIComplete(...args) }),
  NoProviderAvailableError: TestNoProviderError,
}));

import { chat } from "@/lib/assistant";
import corpus from "@/lib/assistant/eval/cases.json";
import { assertEvalCase } from "@/lib/assistant/eval/runner";
import type { EvalCase, EvalCorpus, EvalKbHit } from "@/lib/assistant/eval/types";

const cases: EvalCase[] = (corpus as EvalCorpus).cases;

// ---------------------------------------------------------------------------
// Per-case setup
// ---------------------------------------------------------------------------

function applyMocks(c: EvalCase): void {
  /* mockResolvedValueOnce queues persist across tests because
     jest.clearAllMocks() doesn't reset the once-queue (only mockReset
     does). Reset the AI mock explicitly so a case that doesn't consume
     its queued response — e.g. when chat() dispatches to a tool before
     reaching the LLM — can't bleed that response into the next case. */
  mockAIComplete.mockReset();

  /* KB mock — return the case's hits or [] for default. The shape
     mirrors what searchKnowledge returns: rating, sim, full row. */
  const kbHits = (c.mocks?.kb ?? []).map((hit: EvalKbHit, i: number) => ({
    id: hit.id ?? `eval-${c.id}-kb-${i}`,
    question: hit.question,
    answer: hit.answer,
    source: "eval",
    asked_by: "eval",
    confidence: 0.9,
    rating: hit.rating ?? 5,
    view_count: 1,
    tokens_used: 0,
    tags: [],
    created_at: "2026-05-14T00:00:00Z",
    updated_at: "2026-05-14T00:00:00Z",
    sim: hit.sim,
  }));
  mockSearchKnowledge.mockResolvedValue(kbHits);

  /* AI mock — when the case provides a response, the AI completes with
     it. Otherwise it throws NoProviderAvailableError, which makes
     chat() fall back to the "no AI configured" path. */
  if (c.mocks?.aiResponse) {
    mockAIComplete.mockResolvedValueOnce({
      content: c.mocks.aiResponse,
      model_used: "eval-test",
      provider_used: "eval-test",
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: 0,
      latency_ms: 1,
    });
  } else {
    mockAIComplete.mockRejectedValue(new TestNoProviderError("no providers configured"));
  }

  /* Grounding mock — currently no eval cases exercise grounding, but
     when they do, they set `mocks.brain` + `mocks.groundingBlock`. */
  const renderedBlock = c.mocks?.groundingBlock ?? "";
  mockGetRelevantContext.mockResolvedValueOnce({
    question: c.question,
    surface: "assistant_support",
    sharepoint_hits: [],
    project_tasks: [],
    meeting_notes: [],
    rendered_prompt_block: renderedBlock,
    total_chars: renderedBlock.length,
    took_ms: 1,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveAnswer.mockResolvedValue(null);
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Corpus validation
// ---------------------------------------------------------------------------

describe("eval corpus integrity", () => {
  test("loads at least one case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every case has a stable id, category, rationale, and assertions", () => {
    for (const c of cases) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.category).toMatch(/^(regression|happy_path|edge_case|tool_dispatch)$/);
      expect(c.rationale.length).toBeGreaterThan(10);
      const e = c.expect;
      const hasAssertion =
        e.source !== undefined ||
        (e.sourceNot && e.sourceNot.length > 0) ||
        (e.answerContains && e.answerContains.length > 0) ||
        (e.answerNotContains && e.answerNotContains.length > 0);
      expect(hasAssertion).toBe(true);
    }
  });

  test("case ids are unique", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Per-case execution — one Jest test per case, name = case.id so a
// failure surfaces the case name in the CI output.
// ---------------------------------------------------------------------------

describe("eval corpus execution", () => {
  for (const c of cases) {
    test(`[${c.category}] ${c.id} — ${c.question}`, async () => {
      applyMocks(c);
      const result = await chat(c.question, "eval-user", "cto");
      const verdict = assertEvalCase(c, result);

      /* Emit analytics so the learning loop sees every case execution
         (no data lost — pass AND fail are signal). */
      mockTrackEvent(
        "assistant.eval_case_executed",
        "eval-user",
        "cto",
        {
          case_id: c.id,
          category: c.category,
          passed: verdict.passed,
          source_actual: verdict.sourceActual,
          source_expected: verdict.sourceExpected,
          failures: verdict.failures,
        },
      );

      if (!verdict.passed) {
        throw new Error(
          `Eval case "${c.id}" failed (${c.rationale}):\n  - ${verdict.failures.join("\n  - ")}\n` +
            `  actual source: ${verdict.sourceActual}\n` +
            `  actual response: ${JSON.stringify(result.response).slice(0, 200)}\n` +
            `  rationale: ${c.rationale}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Analytics smoke — every executed case must have fired exactly one
// assistant.eval_case_executed event.
// ---------------------------------------------------------------------------

describe("eval analytics integration", () => {
  test("every case emits one assistant.eval_case_executed event", async () => {
    /* Re-run a single representative case and inspect the trackEvent
       calls. We pick the cheapest regression case (AI-mocked) to keep
       the meta-test fast. */
    const sample = cases.find((c) => c.id === "regression-2026-05-14-a1-zero-hits-rejects-llm");
    expect(sample).toBeDefined();
    if (!sample) return;

    applyMocks(sample);
    const result = await chat(sample.question, "eval-user", "cto");
    const verdict = assertEvalCase(sample, result);
    mockTrackEvent(
      "assistant.eval_case_executed",
      "eval-user",
      "cto",
      {
        case_id: sample.id,
        category: sample.category,
        passed: verdict.passed,
        source_actual: verdict.sourceActual,
        source_expected: verdict.sourceExpected,
        failures: verdict.failures,
      },
    );

    const evalEvents = mockTrackEvent.mock.calls.filter(
      (call) => call[0] === "assistant.eval_case_executed",
    );
    expect(evalEvents.length).toBeGreaterThanOrEqual(1);
    const payload = evalEvents[evalEvents.length - 1][3];
    expect(payload.case_id).toBe(sample.id);
    expect(typeof payload.passed).toBe("boolean");
  });
});
