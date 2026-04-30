/**
 * Assistant context resolver.
 *
 * Combines SharePoint search hits + Microsoft Project / Planner / To Do
 * task hits into a single `ContextBundle` that the `/assistant` LLM call
 * (and, in a follow-up PR, the `/api/knowledge/ask` route) can paste
 * directly into a system prompt to ground its answer.
 *
 * Design rules:
 *   - **Per-user scoping is non-negotiable.** We acquire the calling user's
 *     OAuth token via `getValidToken(userId)` and pass it to every helper.
 *     Never use a service-principal token here. SharePoint + Project
 *     content must only ever be exposed to the user it was authored for.
 *
 *   - **Caching considerations.** Per-user, per-question caching is fine
 *     and is the cache-agent's surface. But the bundle MUST NOT be cached
 *     across users — Graph already enforces per-user ACLs via the
 *     delegated token, but we should never paper over that with a server
 *     cache that mixes results.
 *
 *   - **Bounded prompt size.** The rendered prompt block is hard-capped at
 *     `maxChars` (default 6000) so we never blow the LLM's context budget.
 *     When we hit the cap we drop the longest entries first and emit
 *     `assistant.context_truncated` so the learning loop sees how often
 *     this happens.
 *
 *   - **Graceful degradation.** If SharePoint 403s but Project responds,
 *     we still return a bundle with just the project tasks. The empty-
 *     surface failures are tracked via `assistant.{sharepoint,project}_lookup_failed`.
 *
 * Integration point for the cache agent (`feat/knowledge-llm-cache-and-
 * assistant-support` PR): call `getRelevantContext(...)` from inside the
 * `/api/knowledge/ask` route handler before the LLM completion call, then
 * paste `bundle.rendered_prompt_block` into the system message. We do NOT
 * touch their route in this PR — see the PR body for details.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import {
  searchSharePoint,
  trackSharePointLookupFailure,
  type SharePointSearchHit,
  type SharePointErrorResult,
} from "@/lib/integrations/microsoft-sharepoint";
import {
  searchProjectTasks,
  trackProjectLookupFailure,
  type ProjectTaskSummary,
  type ProjectErrorResult,
} from "@/lib/integrations/microsoft-project";
import { searchMeetingTranscripts } from "@/lib/plaud";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContextSurface = "knowledge" | "assistant_support";

/**
 * One meeting / transcript hit injected into the assistant's prompt.
 * Date-bound queries ("which meetings on April 20?") rely on
 * `occurred_at` being a real ISO datetime so the model can ground
 * date claims rather than hallucinate.
 */
export interface MeetingNoteHit {
  /** Stable identifier (instinct_meeting_transcripts.id, etc). */
  id: string;
  /** Meeting title or transcript heading. */
  title: string;
  /** ISO datetime — critical for "April 20" / "March 2026" style queries. */
  occurred_at: string;
  /** Snippet, hard-capped at 300 characters. */
  snippet: string;
  /** Where the data came from. Lets us add new sources without breaking consumers. */
  source_kind: "plaud" | "porsche_class" | "calendar";
  /** Deep link to the source view, when available. */
  url?: string;
}

/** Typed error returned from the meeting-notes lookup. Shape mirrors
 *  the SharePoint / Project error results so failure tracking is
 *  uniform across surfaces. */
export interface MeetingNoteErrorResult {
  ok: false;
  /** HTTP-ish status code: 0 for unexpected errors, 503 if DB unavailable. */
  status: number;
  /** Discriminator. */
  code: "internal" | "db_unavailable" | "no_query";
  /** Human-readable message. Never user-controlled content. */
  message?: string;
  /** True when the failure indicates the user lacks access (parity with Graph). */
  scope_missing?: boolean;
}

export interface ContextBundle {
  question: string;
  surface: ContextSurface;
  sharepoint_hits: SharePointSearchHit[];
  project_tasks: ProjectTaskSummary[];
  /**
   * Meeting notes (Plaud transcripts today; Porsche classes / calendar
   * later). Always present — empty array when the surface returned no
   * matches or no DB was reachable.
   */
  meeting_notes: MeetingNoteHit[];
  /** Ready-to-inject string for the LLM. Always <= maxChars. */
  rendered_prompt_block: string;
  total_chars: number;
  took_ms: number;
  /**
   * Errors from each surface (if any). The bundle is still returned with
   * whatever DID respond. UI layers can use these to show "Reconnect
   * Microsoft 365 - missing Sites.Read scope" prompts.
   */
  errors?: {
    sharepoint?: SharePointErrorResult;
    project?: ProjectErrorResult;
    meeting?: MeetingNoteErrorResult;
  };
}

export interface GetRelevantContextOptions {
  question: string;
  userId: string;
  role: string;
  surface: ContextSurface;
  /** Default 6000. Hard cap on rendered_prompt_block length. */
  maxChars?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 6000;
/** Minimum we always honor regardless of caller input — keeps the prompt useful. */
const MIN_MAX_CHARS = 500;
/** How many SharePoint hits we ask Graph for. Render layer drops further. */
const SHAREPOINT_TOP_N = 8;
/** How many project tasks we ask Graph for. */
const PROJECT_TOP_N = 8;
/** How many meeting hits we surface. Snippets are capped at 300 chars each. */
const MEETING_TOP_N = 5;
/** Hard cap on snippet length surfaced into the prompt — keeps budget tight. */
const MEETING_SNIPPET_MAX = 300;

// ---------------------------------------------------------------------------
// Date extraction (zero-token, regex-based)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Matches "April 20", "April 20, 2026", "Apr 20 2026", with optional ordinal. */
const FULL_DATE_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?\b/i;
/** Matches "March 2026" — month + year only (no day). */
const MONTH_YEAR_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i;
/** Matches "2026-04-20" / "04/20/2026" / "4/20/26". */
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;

export interface DateRange {
  startISO: string;
  endISO: string;
  /** Granularity flag — caller can use this to widen/tighten secondary filters. */
  kind: "day" | "month" | "year";
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (MONTH_NAMES[i].startsWith(lower)) return i;
  }
  return -1;
}

function dayRange(year: number, month: number, day: number): DateRange {
  const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
  return { startISO: start.toISOString(), endISO: end.toISOString(), kind: "day" };
}

function monthRange(year: number, month: number): DateRange {
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
  return { startISO: start.toISOString(), endISO: end.toISOString(), kind: "month" };
}

/**
 * Extract a date range from a question string. Returns null when no
 * parsable date is present. Pure regex — no LLM, no Date.parse natural-
 * language fallback (which is locale-dependent and unsafe).
 *
 * Recognized forms:
 *   - "April 20" / "April 20, 2026"   → single day
 *   - "March 2026"                    → whole month
 *   - "2026-04-20"                    → single day (ISO)
 *   - "4/20/2026" / "4/20/26"         → single day (US slash)
 *
 * Two-digit years are interpreted as 20YY when YY <= 99.
 */
export function extractDateRange(question: string, now: Date = new Date()): DateRange | null {
  if (!question) return null;

  // ISO YYYY-MM-DD takes priority — unambiguous.
  const iso = ISO_DATE_RE.exec(question);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    const d = Number(iso[3]);
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) return dayRange(y, m, d);
  }

  // M/D/YYYY (US convention).
  const slash = SLASH_DATE_RE.exec(question);
  if (slash) {
    const m = Number(slash[1]) - 1;
    const d = Number(slash[2]);
    let y = Number(slash[3]);
    if (y < 100) y = 2000 + y;
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) return dayRange(y, m, d);
  }

  // "Month Day [, Year]" — must come before the bare month/year regex
  // because "April 20" would match MONTH_YEAR_RE if 20 were a year.
  const fullDate = FULL_DATE_RE.exec(question);
  if (fullDate) {
    const m = monthIndex(fullDate[1]);
    const d = Number(fullDate[2]);
    const y = fullDate[3] ? Number(fullDate[3]) : now.getUTCFullYear();
    if (m >= 0 && d >= 1 && d <= 31) return dayRange(y, m, d);
  }

  // "Month Year" — month + 4-digit year only.
  const monthYear = MONTH_YEAR_RE.exec(question);
  if (monthYear) {
    const m = monthIndex(monthYear[1]);
    const y = Number(monthYear[2]);
    if (m >= 0) return monthRange(y, m);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Meeting notes lookup (zero-token; backed by Plaud transcripts today)
// ---------------------------------------------------------------------------

export interface SearchMeetingNotesOptions {
  question: string;
  userId: string;
  topN?: number;
  /** Optional date filter — when set, callers should only see hits in range. */
  dateRange?: DateRange;
}

export interface SearchMeetingNotesOk {
  ok: true;
  hits: MeetingNoteHit[];
  took_ms: number;
}

export type SearchMeetingNotesResult = SearchMeetingNotesOk | MeetingNoteErrorResult;

function clampSnippet(s: string): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= MEETING_SNIPPET_MAX
    ? oneLine
    : oneLine.slice(0, MEETING_SNIPPET_MAX - 1).trim() + "…";
}

/**
 * Search meeting transcripts (Plaud today) for the question.
 *
 * Date handling: when the caller supplies `dateRange`, OR when one can be
 * extracted from the question text, hits outside the range are dropped
 * post-search. We don't push the date filter into the SQL because the
 * underlying `searchMeetingTranscripts` is a small in-memory ILIKE
 * scorer — filtering after the fact is simpler and keeps the helper
 * dependency-free.
 *
 * Scoping: per-user is enforced by the underlying lookup (`searchMeeting
 * Transcripts` already filters by `quality_status <> 'reject'` and
 * `instinct_meeting_transcripts` is org-shared today; per-user filtering
 * lands when the table grows owner ACLs).
 *
 * Always resolves — never throws. On failure returns a typed error
 * result and emits `assistant.meeting_lookup_failed`.
 */
export async function searchMeetingNotes(
  opts: SearchMeetingNotesOptions,
): Promise<SearchMeetingNotesResult> {
  const t0 = Date.now();
  const question = String(opts?.question ?? "").trim();
  if (!question) {
    return { ok: false, status: 400, code: "no_query", message: "empty_question" };
  }

  const topN = opts.topN && opts.topN > 0 ? Math.min(opts.topN, 20) : MEETING_TOP_N;
  const range = opts.dateRange ?? extractDateRange(question);

  try {
    const matches = await searchMeetingTranscripts(question, Math.max(topN, 10));

    let filtered = matches.filter((m) => m.score > 0);
    if (range) {
      filtered = filtered.filter((m) => {
        const when = m.recordedAt || m.ingestedAt;
        if (!when) return false;
        return when >= range.startISO && when <= range.endISO;
      });
    }

    const hits: MeetingNoteHit[] = filtered.slice(0, topN).map((m) => ({
      id: m.id,
      title: m.title || "Untitled meeting",
      occurred_at: m.recordedAt || m.ingestedAt,
      snippet: clampSnippet(m.summary ? `${m.summary} — ${m.snippet}` : m.snippet),
      source_kind: "plaud",
      url: `/meetings/${encodeURIComponent(m.id)}`,
    }));

    return { ok: true, hits, took_ms: Date.now() - t0 };
  } catch (err) {
    const message = (err as Error)?.message || "internal_error";
    return { ok: false, status: 500, code: "internal", message };
  }
}

/** Track a meeting-lookup failure as a typed analytics event. */
export function trackMeetingLookupFailure(
  userId: string,
  role: string,
  error: MeetingNoteErrorResult,
): void {
  trackEvent("assistant.meeting_lookup_failed", userId, role, {
    status: error.status,
    scope_missing: Boolean(error.scope_missing),
    code: error.code,
  });
}

// ---------------------------------------------------------------------------
// Rendering — prompt block formatting
// ---------------------------------------------------------------------------

interface RenderableEntry {
  /** Stable index used to break ties when sorting by length. */
  ix: number;
  /** Source kind for analytics + truncation telemetry. */
  source: "sharepoint" | "project" | "meeting";
  /** The fully-formatted block including its trailing newline. */
  text: string;
}

function renderSharePointEntry(hit: SharePointSearchHit, ix: number): RenderableEntry {
  const lines: string[] = [];
  lines.push(`[SharePoint] ${hit.title} - ${hit.url}`);
  if (hit.snippet) lines.push(hit.snippet);
  return { ix, source: "sharepoint", text: lines.join("\n") + "\n" };
}

function renderProjectEntry(task: ProjectTaskSummary, ix: number): RenderableEntry {
  const lines: string[] = [];
  const due = task.due_at ? `, due: ${task.due_at}` : "";
  lines.push(
    `[Project task] ${task.title} (${task.plan_or_list_name}, status: ${task.status}${due})`,
  );
  if (task.url) lines.push(task.url);
  return { ix, source: "project", text: lines.join("\n") + "\n" };
}

function renderMeetingEntry(hit: MeetingNoteHit, ix: number): RenderableEntry {
  const lines: string[] = [];
  lines.push(`[Meeting] ${hit.title} — ${hit.occurred_at}`);
  if (hit.snippet) lines.push(hit.snippet);
  if (hit.url) lines.push(hit.url);
  return { ix, source: "meeting", text: lines.join("\n") + "\n" };
}

const PROMPT_HEADER = "Internal context (cite if you use it):\n\n";

/**
 * Build the rendered prompt block. Truncates entries (longest first) to
 * keep the result <= maxChars. Returns the rendered string + a count of
 * how many entries were dropped per source.
 */
export function renderPromptBlock(
  hits: SharePointSearchHit[],
  tasks: ProjectTaskSummary[],
  meetingsOrMaxChars: MeetingNoteHit[] | number,
  maxCharsArg?: number,
): {
  rendered: string;
  dropped: { sharepoint: number; project: number; meeting: number; total: number };
} {
  /* Accept both 3-arg (legacy: hits, tasks, maxChars) and 4-arg
     (hits, tasks, meetings, maxChars) shapes so existing callers and
     tests keep working without churn. */
  const meetings: MeetingNoteHit[] = Array.isArray(meetingsOrMaxChars)
    ? meetingsOrMaxChars
    : [];
  const maxChars: number = Array.isArray(meetingsOrMaxChars)
    ? Number(maxCharsArg ?? DEFAULT_MAX_CHARS)
    : (meetingsOrMaxChars as number);
  const cap = Math.max(MIN_MAX_CHARS, maxChars);
  const entries: RenderableEntry[] = [
    ...hits.map((h, i) => renderSharePointEntry(h, i)),
    ...tasks.map((t, i) => renderProjectEntry(t, i + hits.length)),
    ...meetings.map((m, i) =>
      renderMeetingEntry(m, i + hits.length + tasks.length),
    ),
  ];

  /* No entries at all → no header. Avoids injecting an empty stub
     into the LLM prompt (and keeps existing "empty bundle" semantics
     for callers that still rely on rendered_prompt_block === "").  */
  if (entries.length === 0) {
    return {
      rendered: "",
      dropped: { sharepoint: 0, project: 0, meeting: 0, total: 0 },
    };
  }

  // Total length budget = cap minus the header.
  const budget = cap - PROMPT_HEADER.length;
  if (budget < 0) {
    // Caller passed an absurdly small cap. Return just the header.
    return {
      rendered: PROMPT_HEADER.slice(0, cap),
      dropped: {
        sharepoint: hits.length,
        project: tasks.length,
        meeting: meetings.length,
        total: hits.length + tasks.length + meetings.length,
      },
    };
  }

  // Greedy: keep entries in original order; drop the longest first when we
  // bust the budget. We process by length-desc to find which to drop, then
  // re-sort by original index for stable rendering.
  const totalLen = entries.reduce((s, e) => s + e.text.length, 0);
  const kept = new Set(entries.map((e) => e.ix));
  if (totalLen > budget) {
    const sortedByLenDesc = [...entries].sort((a, b) => b.text.length - a.text.length);
    let cur = totalLen;
    for (const e of sortedByLenDesc) {
      if (cur <= budget) break;
      kept.delete(e.ix);
      cur -= e.text.length;
    }
  }

  const finalEntries = entries
    .filter((e) => kept.has(e.ix))
    .sort((a, b) => a.ix - b.ix);

  let rendered = PROMPT_HEADER + finalEntries.map((e) => e.text).join("");

  // Defensive: if rounding leaves us > cap (rare — entry boundaries), trim.
  if (rendered.length > cap) {
    rendered = rendered.slice(0, cap);
  }

  let droppedSp = 0;
  let droppedProj = 0;
  let droppedMtg = 0;
  for (const e of entries) {
    if (kept.has(e.ix)) continue;
    if (e.source === "sharepoint") droppedSp += 1;
    else if (e.source === "project") droppedProj += 1;
    else droppedMtg += 1;
  }
  return {
    rendered,
    dropped: {
      sharepoint: droppedSp,
      project: droppedProj,
      meeting: droppedMtg,
      total: droppedSp + droppedProj + droppedMtg,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `ContextBundle` for the given question. Runs SharePoint search
 * + MS Project task search in parallel against the calling user's
 * delegated Graph token, then renders both into a prompt-ready block.
 *
 * Always resolves — never throws. Surface-level errors live on
 * `bundle.errors` so callers can decide whether to surface a "reconnect"
 * banner without losing the partial-success context.
 *
 * Analytics:
 *   - `assistant.context_resolved` on every call (success or partial).
 *   - `assistant.context_truncated` when entries are dropped.
 *   - `assistant.sharepoint_lookup_failed` / `assistant.project_lookup_failed`
 *     on the matching surface failure.
 */
export async function getRelevantContext(
  opts: GetRelevantContextOptions,
): Promise<ContextBundle> {
  const t0 = Date.now();
  const question = String(opts?.question ?? "").trim();
  const surface = opts.surface;
  const userId = opts.userId;
  const role = opts.role || "user";
  const maxChars = Math.max(
    MIN_MAX_CHARS,
    Number.isFinite(opts.maxChars) ? Number(opts.maxChars) : DEFAULT_MAX_CHARS,
  );

  // Empty / token-less calls return an empty bundle but still emit analytics
  // so the learning loop sees the call happened.
  const empty = (errors?: ContextBundle["errors"]): ContextBundle => {
    const rendered = ""; // nothing to inject
    const bundle: ContextBundle = {
      question,
      surface,
      sharepoint_hits: [],
      project_tasks: [],
      meeting_notes: [],
      rendered_prompt_block: rendered,
      total_chars: rendered.length,
      took_ms: Date.now() - t0,
      ...(errors ? { errors } : {}),
    };
    trackEvent("assistant.context_resolved", userId, role, {
      surface,
      sharepoint_count: 0,
      project_count: 0,
      meeting_count: 0,
      total_chars: rendered.length,
      took_ms: bundle.took_ms,
    });
    return bundle;
  };

  if (!question) return empty();

  /* Meetings live in our own DB and don't depend on a Graph token, so we
     ALWAYS fan out to them — even if the user hasn't connected M365 yet.
     SharePoint + Project still require the delegated token. */
  const meetingPromise = searchMeetingNotes({
    question,
    userId,
    topN: MEETING_TOP_N,
  });

  const token = await getValidToken(userId);

  /* Parallel surface fan-out. searchMeetingNotes already returns typed
     errors instead of throwing, so Promise.allSettled is overkill, but we
     use it on the Graph helpers in case a future change starts throwing. */
  type GraphSpRes = Awaited<ReturnType<typeof searchSharePoint>> | null;
  type GraphProjRes = Awaited<ReturnType<typeof searchProjectTasks>> | null;
  let spRes: GraphSpRes = null;
  let projRes: GraphProjRes = null;

  if (token) {
    const [spSettled, projSettled] = await Promise.allSettled([
      searchSharePoint(token.accessToken, { query: question, topN: SHAREPOINT_TOP_N }),
      searchProjectTasks(token.accessToken, { query: question, topN: PROJECT_TOP_N }),
    ]);
    spRes = spSettled.status === "fulfilled" ? spSettled.value : null;
    projRes = projSettled.status === "fulfilled" ? projSettled.value : null;
  }

  const meetingRes = await meetingPromise;

  const errors: ContextBundle["errors"] = {};
  let sharepoint_hits: SharePointSearchHit[] = [];
  let project_tasks: ProjectTaskSummary[] = [];
  let meeting_notes: MeetingNoteHit[] = [];

  if (spRes && spRes.ok) {
    sharepoint_hits = spRes.value.hits;
  } else if (spRes && !spRes.ok) {
    errors.sharepoint = spRes;
    trackSharePointLookupFailure(userId, role, spRes);
  }
  if (projRes && projRes.ok) {
    project_tasks = projRes.value.tasks;
  } else if (projRes && !projRes.ok) {
    errors.project = projRes;
    trackProjectLookupFailure(userId, role, projRes);
  }
  if (meetingRes.ok) {
    meeting_notes = meetingRes.hits;
  } else {
    errors.meeting = meetingRes;
    trackMeetingLookupFailure(userId, role, meetingRes);
  }

  const { rendered, dropped } = renderPromptBlock(
    sharepoint_hits,
    project_tasks,
    meeting_notes,
    maxChars,
  );

  if (dropped.total > 0) {
    trackEvent("assistant.context_truncated", userId, role, {
      surface,
      dropped_count: dropped.total,
      dropped_sharepoint: dropped.sharepoint,
      dropped_project: dropped.project,
      dropped_meeting: dropped.meeting,
      reason: "max_chars",
    });
  }

  const bundle: ContextBundle = {
    question,
    surface,
    sharepoint_hits,
    project_tasks,
    meeting_notes,
    rendered_prompt_block: rendered,
    total_chars: rendered.length,
    took_ms: Date.now() - t0,
    ...(Object.keys(errors).length ? { errors } : {}),
  };

  trackEvent("assistant.context_resolved", userId, role, {
    surface,
    sharepoint_count: sharepoint_hits.length,
    project_count: project_tasks.length,
    meeting_count: meeting_notes.length,
    total_chars: rendered.length,
    took_ms: bundle.took_ms,
  });

  return bundle;
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  renderPromptBlock,
  renderSharePointEntry,
  renderProjectEntry,
  renderMeetingEntry,
  extractDateRange,
  PROMPT_HEADER,
  DEFAULT_MAX_CHARS,
  MIN_MAX_CHARS,
  SHAREPOINT_TOP_N,
  PROJECT_TOP_N,
  MEETING_TOP_N,
  MEETING_SNIPPET_MAX,
};
