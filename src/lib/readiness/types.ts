/**
 * Production-readiness engine - types.
 *
 * Sibling of the compliance engine (src/lib/compliance): same honest,
 * evidence-driven shape (a criterion derives a ready/partial/gap status from
 * measured evidence, and the report aggregates a coverage score), but the
 * evidence here is STATIC FACTS ABOUT THE REPO rather than runtime posture.
 * "Does this tool have a DB-layer test", "is its RLS a real policy or a
 * USING(true) tripwire", "does its E2E gate on a PR or skip green" - deterministic
 * signals computed by scanning the source tree.
 *
 * Why it exists: a tool's readiness should be a LIVE, machine-checked number that
 * stays true as the code changes, not a doc that rots. Each gap it reports is a
 * concrete next task, so the score climbing IS the project moving to completion.
 * It dogfoods by construction: it scans our own repo.
 *
 * Honest by design: an AUTO criterion is backed by a static check; an ATTESTED
 * criterion is human-maintained and is shown as such - never silently counted as
 * ready. Mirrors the compliance engine's "never a blanket compliant claim".
 */

/** A tool is ready, partially there, or has a gap on a given criterion. */
export type ReadinessStatus = "ready" | "partial" | "gap";

/** The dimension a criterion belongs to. These are the axes a real production
 *  review walks: can two tenants leak into each other, is it tested at every
 *  layer, does it fail closed and legibly, is every action observable/audited,
 *  does a missing env var silently degrade it, and is the core behavior correct. */
export type ReadinessDimension =
  | "isolation"
  | "tests"
  | "fail-closed"
  | "observability"
  | "config-safety"
  | "correctness";

/** Static facts about one tool, computed by scanning the repo. Flexible bag:
 *  each tool populates the keys its criteria read. null = "could not determine"
 *  (honest - distinct from a measured false). */
export type SignalValue = boolean | number | string | null;
export type ToolSignals = Record<string, SignalValue>;

/** Minimal read-only view of the repo the collectors scan. Injected so the
 *  analysis is pure and tests are hermetic (a fake reader, no filesystem). */
export interface RepoReader {
  /** File contents, or null when the file does not exist. */
  read(path: string): string | null;
  /** true when the path exists (file or dir). */
  exists(path: string): boolean;
  /** Repo-relative file paths under `dir` (recursive) whose basename ends with
   *  `suffix` (when given). Empty when the dir does not exist. */
  listFiles(dir: string, suffix?: string): string[];
}

/** One readiness criterion for a tool. Pure: status + evidence are functions of
 *  the computed signals, so the report is reproducible. */
export interface ReadinessCriterion {
  id: string;
  dimension: ReadinessDimension;
  title: string;
  /** Why this matters - the failure it prevents. */
  rationale: string;
  /** auto = a static check backs it; attested = human-maintained (shown honestly). */
  kind: "auto" | "attested";
  status(s: ToolSignals): ReadinessStatus;
  evidence(s: ToolSignals): string;
}

/** One tool under readiness tracking. `collectSignals` scans the repo; `criteria`
 *  grade those signals. Keeping the scan local to the tool keeps it testable. */
export interface ToolSpec {
  id: string;
  label: string;
  /** The user-facing surface, for the report header. */
  surface: string;
  collectSignals(reader: RepoReader): ToolSignals;
  criteria: ReadinessCriterion[];
}

export interface CriterionResult {
  id: string;
  dimension: ReadinessDimension;
  title: string;
  rationale: string;
  kind: "auto" | "attested";
  status: ReadinessStatus;
  evidence: string;
}

export interface ToolReadinessReport {
  toolId: string;
  label: string;
  surface: string;
  results: CriterionResult[];
  ready: number;
  partial: number;
  gap: number;
  total: number;
  /** (ready + 0.5*partial) / total, 0..1. Partial earns half credit so progress
   *  from gap -> partial -> ready is visible, not binary. */
  score: number;
  /** Per-dimension score for the same formula, so a weak axis is obvious. */
  byDimension: Record<string, { ready: number; partial: number; gap: number; score: number }>;
}
