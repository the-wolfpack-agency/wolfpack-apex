/**
 * AI-code governance — types.
 *
 * AI agents (Copilot, Cursor, Devin, our own agents) now author code faster than
 * human review can keep up. This module gates an AI-authored DIFF before it
 * merges: it scans the ADDED lines for security risks, CWE-classifies each, and a
 * deterministic gate returns a verdict (allow / escalate / block) - the same
 * "models propose, policy decides" principle OGIAM applies to agent actions,
 * applied to the code an AI writes. Every review is recorded for the audit + the
 * learning loop.
 */

export type CodeFindingSeverity = "low" | "medium" | "high" | "critical";

export interface AiCodeFinding {
  /** File path from the diff. */
  file: string;
  /** New-file line number of the added line. */
  line: number;
  /** Detector class (secret | eval_exec | disabled_tls | ...). */
  klass: string;
  severity: CodeFindingSeverity;
  /** CWE id where one applies, e.g. "CWE-798". */
  cwe: string | null;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
}

/** One added line from a parsed unified diff. */
export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export type CodeGateOutcome = "allow" | "escalate" | "block";

export interface CodeGateVerdict {
  outcome: CodeGateOutcome;
  highestSeverity: CodeFindingSeverity | "none";
  reason: string;
  /** Stable id of the rule that decided, for explainability. */
  ruleId: string;
}

export interface CodeReviewResult {
  ref: string;
  author: string;
  findings: AiCodeFinding[];
  verdict: CodeGateVerdict;
  bySeverity: Record<string, number>;
}
