/**
 * Answer-relevance eval harness — case schema.
 *
 * The harness exists because today's unit tests verify code paths in
 * isolation but never assert "for question X, the answer must NOT come
 * from cache entry Y" or "for an off-topic question, the source must
 * be `ai`." The 2026-05-14 regression — every general-knowledge
 * question silently served the canned reject — would have been caught
 * by a single case here.
 *
 * Every case carries:
 *   - what to ask
 *   - which mocks to set up (KB hits with similarity scores, brain
 *     hits with retrieval scores, the AI mock's reply)
 *   - what to assert about the result (source label, answer contents,
 *     forbidden phrases)
 *
 * The runner in eval-harness.test.ts iterates the corpus, wires the
 * mocks, calls chat(), and asserts. Every case run emits an
 * `assistant.eval_case_executed` analytics event so the learning loop
 * sees regressions over time.
 */

export type EvalSource =
  | "ai"
  | "knowledge_cache"
  | "page_facts"
  | "brain"
  | "tool"
  | "fallback"
  | "user_qa_cache";

export type EvalCategory =
  | "regression"
  | "happy_path"
  | "edge_case"
  | "tool_dispatch";

/** Shape of a KB hit the runner injects into mockSearchKnowledge. */
export interface EvalKbHit {
  question: string;
  answer: string;
  /** Postgres trigram similarity (0..1) — drives the KB_MIN_SIMILARITY
   *  gate in tryKnowledgeBase. Required for every hit because cases
   *  without sim bypass the gate (demo-mode back-compat) and would
   *  give false positives. */
  sim: number;
  /** Default 5 (passing). Drop to 1 to exercise low-quality skip. */
  rating?: number;
  id?: string;
}

/** Shape of a brain hit the runner injects via mockGetRelevantContext. */
export interface EvalBrainHit {
  document_id: string;
  document_filename: string;
  content: string;
  score: number;
}

export interface EvalCase {
  /** Stable identifier; lives forever. Tag with `regression-<date>` or
   *  `happy-<topic>` so triage knows what it's protecting. */
  id: string;
  category: EvalCategory;
  /** Human-readable why this case exists. Cite the regression date or
   *  the customer demo it protects. */
  rationale: string;
  question: string;

  /** Mocked context the runner injects before calling chat(). */
  mocks?: {
    kb?: EvalKbHit[];
    /** AI mock reply for this case. Set when the case expects source=ai. */
    aiResponse?: string;
    /** Brain retrieval context. */
    brain?: EvalBrainHit[];
    /** Pre-built grounding block to inject via getRelevantContext. */
    groundingBlock?: string;
  };

  /** Assertions to run against the chat() result. */
  expect: {
    /** Exact match on result.source. */
    source?: EvalSource;
    /** result.source must NOT be any of these. */
    sourceNot?: EvalSource[];
    /** Every substring must appear in result.response (case-insensitive). */
    answerContains?: string[];
    /** No substring may appear in result.response (case-insensitive). */
    answerNotContains?: string[];
  };
}

export interface EvalCorpus {
  version: number;
  cases: EvalCase[];
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  sourceActual: string;
  sourceExpected?: string;
}
