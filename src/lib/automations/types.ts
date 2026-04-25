/**
 * Modular Automations framework — shared types.
 *
 * The automations surface (`/automations/...`) is a multi-tenant
 * workspace for codifying a team member's manual recurring workflow.
 * The first registered automation is `porsche-classes` (the program owner's
 * BA101/102 registration + summary work) but the route family is
 * deliberately generic so the next client automation is config-only:
 * register a new entry in `lib/automations/registry.ts`, give it
 * parsers + a renderer, and the dashboard / changes / exceptions /
 * summaries pages light up.
 *
 * Two streams build against this contract in parallel:
 *   - Stream A owns ingest, delta, dashboard, exception queue.
 *   - Stream B owns the per-source parsers (Cognito coordinator,
 *     Cognito instructor, survey) and the summary assembler/renderer.
 *
 * Both streams import from this file ONLY for the contract — never
 * from each other's implementation files. That keeps the merge
 * trivial when both worktrees come back.
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** A single ingest source within an automation (one parser implementation). */
export type AutomationSourceType =
  | "porsche_xlsx"
  | "cognito_coordinator"
  | "cognito_instructor"
  | "survey"
  // meeting-insights — generic email body + attachments. Stream B's
  // per-mime extractors (.docx, .pdf) sit BEHIND the single `email`
  // source-type because the shape of the parsed output (a body + a
  // list of attachments) is the same regardless of which extractor
  // ran. The orchestrator dispatches to mime-specific extractors
  // internally rather than registering one per mime here.
  | "email";

/** Stable, route-safe identifier for an automation in the registry. */
export type AutomationId = "porsche-classes" | "meeting-insights";

/* ------------------------------------------------------------------ */
/* Class identity (porsche-classes specific but reusable shape)        */
/* ------------------------------------------------------------------ */

/** `course|YYYY-MM-DD|location` — deterministic, normalized. */
export type ClassKey = string;

export type CourseType = "BA101" | "BA102";

export interface ParsedClass {
  course_type: CourseType;
  /** ISO date `YYYY-MM-DD`, no time component. */
  class_date: string;
  /** Title-cased, trimmed, internal whitespace collapsed. */
  location: string;
  /** Lowercased, deduped, sorted. */
  participants: string[];
}

/* ------------------------------------------------------------------ */
/* Snapshot — one parsed view of one class at one ingest point         */
/* ------------------------------------------------------------------ */

export interface SnapshotInput {
  source_type: AutomationSourceType;
  source_message_id: string | null;
  source_artifact_id: string;
  captured_at: string; // ISO datetime
  class: ParsedClass;
  /** Free-form payload the parser kept (e.g. instructor open-text). */
  source_payload?: Record<string, unknown>;
}

export interface SnapshotRecord extends SnapshotInput {
  id: string; // uuid
  class_key: ClassKey;
  participant_hash: string; // sha256 of sorted-lowercase participant list
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Delta — change between two consecutive snapshots for one class_key  */
/* ------------------------------------------------------------------ */

export interface DeltaRecord {
  id: string; // uuid
  automation_id: AutomationId;
  class_key: ClassKey;
  prev_snapshot_id: string | null; // null = baseline
  curr_snapshot_id: string;
  added: string[];
  dropped: string[];
  net_change: number;
  is_baseline: boolean;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Override — the program owner's manual correction (training data for matcher)   */
/* ------------------------------------------------------------------ */

export type OverrideKind =
  | "class_match" // "this snapshot belongs to a different class_key"
  | "participant_alias" // "Bob Smith" === "Robert Smith"
  | "exclude_class" // not a real class — ignore
  | "exclude_participant"; // not a real participant — ignore

export interface OverrideRecord {
  id: string;
  automation_id: AutomationId;
  kind: OverrideKind;
  /** What we matched to. */
  from_value: string;
  /** What it should be. */
  to_value: string;
  reason: string | null;
  created_by: string; // user email
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Exception — a parse/match that needs human review                   */
/* ------------------------------------------------------------------ */

export type ExceptionKind =
  | "parse_failure"
  | "low_confidence_match"
  | "missing_field"
  | "duplicate_artifact";

export interface ExceptionRecord {
  id: string;
  automation_id: AutomationId;
  artifact_id: string;
  kind: ExceptionKind;
  detail: string;
  status: "open" | "resolved" | "dismissed";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Parser contract                                                     */
/* ------------------------------------------------------------------ */

export interface ParseInput {
  /** Raw bytes of the artifact (eml, xlsx, etc.). */
  bytes: Buffer;
  /** Original filename or message subject. */
  hint: string;
  /** When the artifact was received. */
  received_at: string;
  /** Source message-id if available (from email envelope). */
  source_message_id: string | null;
  /** Stored artifact id this parser is operating on. */
  source_artifact_id: string;
}

export interface ParseSuccess {
  ok: true;
  source_type: AutomationSourceType;
  snapshots: SnapshotInput[];
}

export interface ParseFailure {
  ok: false;
  source_type: AutomationSourceType;
  error: string;
  exception_kind: ExceptionKind;
  detail?: Record<string, unknown>;
}

export type ParseResult = ParseSuccess | ParseFailure;

export type Parser = (input: ParseInput) => Promise<ParseResult>;

/* ------------------------------------------------------------------ */
/* Summary assembler contract                                          */
/* ------------------------------------------------------------------ */

export interface AssembledSummary {
  class_key: ClassKey;
  course_type: CourseType;
  class_date: string;
  location: string;
  /** Source counts by parser. */
  sources: Record<AutomationSourceType, number>;
  /** Final participants per latest snapshot from the registration source. */
  participants: string[];
  /** Coordinator notes per coordinator (free text). */
  coordinator_notes: { author: string; note: string }[];
  /** Instructor notes per instructor (free text). */
  instructor_notes: { author: string; note: string }[];
  /** Survey aggregate, when present. */
  survey: SurveyAggregate | null;
  /** Any open exceptions touching this class. */
  open_exceptions: ExceptionRecord[];
  generated_at: string;
}

export interface SurveyAggregate {
  response_count: number;
  /** Average 1-5 score across all rating questions, when uniform. */
  average_score: number | null;
  /** Question-by-question rollup. */
  questions: { question: string; average: number | null; comments: string[] }[];
}

/* ------------------------------------------------------------------ */
/* Registry — describes an automation and its capabilities             */
/* ------------------------------------------------------------------ */

export interface AutomationDefinition {
  id: AutomationId;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Owner / primary user (email or display label). */
  owner_label: string;
  /** Short description for the dashboard tile. */
  description: string;
  /** Window in days for "active" classes the digest cares about. */
  active_window_days: { min: number; max: number };
  /** Subject-line / sender filters for the inbox poller. STATIC fallback;
   *  if `loadInboxFilters` is also set, that wins for delta-feed dispatch
   *  but this static set still serves as a safety net for any caller
   *  that doesn't await the dynamic loader. */
  inbox_filters: {
    sender_match?: string[]; // substrings
    subject_match?: string[]; // substrings
  };
  /** Optional dynamic filter loader. When set, the inbox poller calls this
   *  ONCE per tick and uses the union as the effective filter. Lets
   *  automations whose filters live in the database (meeting-insights
   *  feeds) react to admin changes without a redeploy. Falls back to the
   *  static `inbox_filters` field if this isn't set or if it throws. */
  loadInboxFilters?: () => Promise<{
    sender_match?: string[];
    subject_match?: string[];
  }>;
  /** Parsers keyed by source_type. */
  parsers: Partial<Record<AutomationSourceType, Parser>>;
  /** Optional summary assembler. */
  assemble_summary?: (
    class_key: ClassKey,
  ) => Promise<AssembledSummary | null>;
}
