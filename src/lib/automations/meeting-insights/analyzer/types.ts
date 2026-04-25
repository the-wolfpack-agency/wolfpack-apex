/**
 * meeting-insights / analyzer / types — strict types for the LLM analysis
 * output. The analyzer parses Claude Haiku's JSON response into these
 * shapes; anything that doesn't match drops to status='partial'.
 *
 * Each field is a list (zero or more items) of plain objects. We keep
 * fields optional past the human-load-bearing keys so the LLM can opt
 * out without forcing hallucinated values.
 *
 * Ontology integration: each list maps to a row in instinct_meeting_analyses
 * and a (typed) graph node in Neo4j (Phase 3) — keep the keys stable.
 */

export interface MeetingDecision {
  summary: string;
  rationale?: string;
  owners?: string[];
  /** Verbatim quote from the body that grounds this decision. */
  source_quote?: string;
}

export interface MeetingActionItem {
  description: string;
  owner?: string;
  due?: string;
  completed?: boolean;
  source_quote?: string;
}

export interface MeetingAttendee {
  name?: string;
  email?: string;
  role?: string;
}

export interface MeetingBlocker {
  description: string;
  severity?: "low" | "medium" | "high";
}

export interface MeetingNextStep {
  description: string;
  when?: string;
}

/**
 * Full analysis output. `topics` is denormalised to a flat string[] for
 * the GIN-indexed theme tracker; `attendees` etc. stay structured.
 */
export interface MeetingAnalysis {
  decisions: MeetingDecision[];
  action_items: MeetingActionItem[];
  topics: string[];
  attendees: MeetingAttendee[];
  blockers: MeetingBlocker[];
  next_steps: MeetingNextStep[];
}

/**
 * Status the analyzer landed in. Mirrors the DB CHECK constraint.
 *  - success: clean parse, schema valid.
 *  - partial: response received but failed validation; raw kept.
 *  - error: SDK / credential / network failure; no usable response.
 */
export type MeetingAnalysisStatus = "success" | "partial" | "error";

export interface MeetingAnalysisResult {
  status: MeetingAnalysisStatus;
  analysis: MeetingAnalysis;
  raw_llm_response?: string;
  model?: string;
  tokens_used?: number;
  error_detail?: string;
}

/**
 * Bumped when the prompt or schema changes. Stored on every row so we
 * can re-analyse with a new prompt without losing prior history.
 *
 * Format: 'YYYY-MM-DD.N'.
 */
export const ANALYZER_VERSION = "2026-04-24.1";

/** Default model — claude-haiku-4-5 (per spec). */
export const ANALYZER_MODEL = "claude-haiku-4-5";

/** Empty analysis used as a safe default for error/partial paths. */
export const EMPTY_ANALYSIS: MeetingAnalysis = {
  decisions: [],
  action_items: [],
  topics: [],
  attendees: [],
  blockers: [],
  next_steps: [],
};
