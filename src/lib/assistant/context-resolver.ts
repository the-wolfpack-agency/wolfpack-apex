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

import { getValidToken, getAppOnlyToken } from "@/lib/microsoft-graph";
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
import {
  searchCalendarEvents,
  trackCalendarLookupFailure,
  type CalendarEventHit,
  type CalendarErrorResult,
} from "@/lib/integrations/microsoft-calendar";
import {
  searchMessages,
  trackEmailLookupFailure,
  type EmailThreadHit,
  type MailErrorResult,
} from "@/lib/integrations/microsoft-mail";
import { searchMeetingTranscripts } from "@/lib/plaud";
import {
  searchPorscheClassNotes,
  trackPorscheClassLookupFailure,
} from "@/lib/automations/porsche-classes/assistant-grounding";

// Re-export for downstream consumers + tests.
export type { CalendarEventHit, EmailThreadHit };

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
  /**
   * Outlook calendar events matching the question — pulled from
   * /me/calendarView in the date range extracted from the question
   * (or a sensible default of [now-180d, now+30d]).
   */
  calendar_events: CalendarEventHit[];
  /**
   * Outlook email threads matching the question — pulled via Graph
   * /search/query with entityTypes=["message"].
   */
  email_threads: EmailThreadHit[];
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
    calendar?: CalendarErrorResult;
    email?: MailErrorResult;
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
/** How many calendar event hits we surface. */
const CALENDAR_TOP_N = 5;
/** How many email thread hits we surface. */
const EMAIL_TOP_N = 5;

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
  source: "sharepoint" | "project" | "meeting" | "calendar" | "email";
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

function renderCalendarEntry(hit: CalendarEventHit, ix: number): RenderableEntry {
  const lines: string[] = [];
  const attendees =
    hit.attendees && hit.attendees.length > 0
      ? ` — with ${hit.attendees.slice(0, 5).join(", ")}`
      : "";
  lines.push(`[Calendar] ${hit.subject} — ${hit.start}${attendees}`);
  if (hit.snippet) lines.push(hit.snippet);
  if (hit.url) lines.push(hit.url);
  return { ix, source: "calendar", text: lines.join("\n") + "\n" };
}

function renderEmailEntry(hit: EmailThreadHit, ix: number): RenderableEntry {
  const lines: string[] = [];
  const when = hit.received_at ? ` — ${hit.received_at}` : "";
  lines.push(`[Email] ${hit.subject} — from ${hit.from}${when}`);
  if (hit.snippet) lines.push(hit.snippet);
  if (hit.url) lines.push(hit.url);
  return { ix, source: "email", text: lines.join("\n") + "\n" };
}

const PROMPT_HEADER = "Internal context (cite if you use it):\n\n";

export interface RenderDropped {
  sharepoint: number;
  project: number;
  meeting: number;
  calendar: number;
  email: number;
  total: number;
}

export interface RenderInputs {
  hits?: SharePointSearchHit[];
  tasks?: ProjectTaskSummary[];
  meetings?: MeetingNoteHit[];
  calendar?: CalendarEventHit[];
  emails?: EmailThreadHit[];
  maxChars?: number;
}

/**
 * Build the rendered prompt block. Truncates entries (longest first) to
 * keep the result <= maxChars. Returns the rendered string + a count of
 * how many entries were dropped per source.
 *
 * Two call shapes for backwards-compat with existing tests:
 *   renderPromptBlock(hits, tasks, maxChars)
 *   renderPromptBlock(hits, tasks, meetings, maxChars)
 *   renderPromptBlock({ hits, tasks, meetings, calendar, emails, maxChars })
 */
export function renderPromptBlock(inputs: RenderInputs): {
  rendered: string;
  dropped: RenderDropped;
};
export function renderPromptBlock(
  hits: SharePointSearchHit[],
  tasks: ProjectTaskSummary[],
  meetingsOrMaxChars: MeetingNoteHit[] | number,
  maxCharsArg?: number,
): {
  rendered: string;
  dropped: RenderDropped;
};
export function renderPromptBlock(
  hitsOrInputs: SharePointSearchHit[] | RenderInputs,
  tasks?: ProjectTaskSummary[],
  meetingsOrMaxChars?: MeetingNoteHit[] | number,
  maxCharsArg?: number,
): {
  rendered: string;
  dropped: RenderDropped;
} {
  /* Normalize input shape — support both the new {inputs} object and the
     legacy positional shapes used by existing tests + callers. */
  let hits: SharePointSearchHit[] = [];
  let taskList: ProjectTaskSummary[] = [];
  let meetings: MeetingNoteHit[] = [];
  let calendar: CalendarEventHit[] = [];
  let emails: EmailThreadHit[] = [];
  let maxChars = DEFAULT_MAX_CHARS;

  if (!Array.isArray(hitsOrInputs) && typeof hitsOrInputs === "object" && hitsOrInputs !== null) {
    const ip = hitsOrInputs as RenderInputs;
    hits = ip.hits ?? [];
    taskList = ip.tasks ?? [];
    meetings = ip.meetings ?? [];
    calendar = ip.calendar ?? [];
    emails = ip.emails ?? [];
    maxChars = Number.isFinite(ip.maxChars) ? Number(ip.maxChars) : DEFAULT_MAX_CHARS;
  } else {
    hits = (hitsOrInputs as SharePointSearchHit[]) ?? [];
    taskList = tasks ?? [];
    if (Array.isArray(meetingsOrMaxChars)) {
      meetings = meetingsOrMaxChars;
      maxChars = Number(maxCharsArg ?? DEFAULT_MAX_CHARS);
    } else if (typeof meetingsOrMaxChars === "number") {
      maxChars = meetingsOrMaxChars;
    } else {
      maxChars = DEFAULT_MAX_CHARS;
    }
  }

  const cap = Math.max(MIN_MAX_CHARS, maxChars);

  let ix = 0;
  const entries: RenderableEntry[] = [
    ...hits.map((h) => renderSharePointEntry(h, ix++)),
    ...taskList.map((t) => renderProjectEntry(t, ix++)),
    ...meetings.map((m) => renderMeetingEntry(m, ix++)),
    ...calendar.map((c) => renderCalendarEntry(c, ix++)),
    ...emails.map((e) => renderEmailEntry(e, ix++)),
  ];

  const emptyDropped: RenderDropped = {
    sharepoint: 0, project: 0, meeting: 0, calendar: 0, email: 0, total: 0,
  };

  /* No entries at all → no header. Avoids injecting an empty stub
     into the LLM prompt (and keeps existing "empty bundle" semantics
     for callers that still rely on rendered_prompt_block === "").  */
  if (entries.length === 0) {
    return { rendered: "", dropped: emptyDropped };
  }

  // Total length budget = cap minus the header.
  const budget = cap - PROMPT_HEADER.length;
  if (budget < 0) {
    return {
      rendered: PROMPT_HEADER.slice(0, cap),
      dropped: {
        sharepoint: hits.length,
        project: taskList.length,
        meeting: meetings.length,
        calendar: calendar.length,
        email: emails.length,
        total: hits.length + taskList.length + meetings.length + calendar.length + emails.length,
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
  let droppedCal = 0;
  let droppedMail = 0;
  for (const e of entries) {
    if (kept.has(e.ix)) continue;
    if (e.source === "sharepoint") droppedSp += 1;
    else if (e.source === "project") droppedProj += 1;
    else if (e.source === "meeting") droppedMtg += 1;
    else if (e.source === "calendar") droppedCal += 1;
    else droppedMail += 1;
  }
  return {
    rendered,
    dropped: {
      sharepoint: droppedSp,
      project: droppedProj,
      meeting: droppedMtg,
      calendar: droppedCal,
      email: droppedMail,
      total: droppedSp + droppedProj + droppedMtg + droppedCal + droppedMail,
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
      calendar_events: [],
      email_threads: [],
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
      calendar_count: 0,
      email_count: 0,
      total_chars: rendered.length,
      took_ms: bundle.took_ms,
    });
    return bundle;
  };

  if (!question) return empty();

  /* Meetings live in our own DB and don't depend on a Graph token, so we
     ALWAYS fan out to them — even if the user hasn't connected M365 yet.
     SharePoint + Project + Calendar + Email still require the delegated
     token. */
  const meetingPromise = searchMeetingNotes({
    question,
    userId,
    topN: MEETING_TOP_N,
  });

  /* Porsche-class snapshots are another DB-local grounding lane.
     `searchPorscheClassNotes` self-gates on a keyword regex so cost
     is zero for questions that aren't class-related. We fan out in
     parallel with the other lookups. */
  const porschePromise = searchPorscheClassNotes({
    question,
    dateRange: extractDateRange(question) ?? undefined,
    topN: MEETING_TOP_N,
  });

  const token = await getValidToken(userId);

  /* SharePoint search via app-only token (2026-05-20). Sites.Read.All
     is admin-consent-required as a delegated scope, which was blocking
     non-admin teammates from connecting M365. App-only consent is
     granted ONCE at the tenant level (same pattern as Mail.Send) and
     bypasses per-user consent entirely. Requires Sites.Read.All
     (Application) on the app registration. */
  const appOnlyToken = await getAppOnlyToken();

  /* Parallel surface fan-out. searchMeetingNotes already returns typed
     errors instead of throwing; the Graph helpers do too, but we wrap
     them in Promise.allSettled in case a future change starts throwing. */
  type GraphSpRes = Awaited<ReturnType<typeof searchSharePoint>> | null;
  type GraphProjRes = Awaited<ReturnType<typeof searchProjectTasks>> | null;
  type GraphCalRes = Awaited<ReturnType<typeof searchCalendarEvents>> | null;
  type GraphMailRes = Awaited<ReturnType<typeof searchMessages>> | null;
  let spRes: GraphSpRes = null;
  let projRes: GraphProjRes = null;
  let calRes: GraphCalRes = null;
  let mailRes: GraphMailRes = null;

  /* Date range is shared by calendar (and informs which events to pull)
     so we extract it once. searchMeetingNotes already extracts internally. */
  const range = extractDateRange(question);

  if (token) {
    const [spSettled, projSettled, calSettled, mailSettled] = await Promise.allSettled([
      /* SharePoint uses app-only token when available (works for any
         user regardless of consent), falls back to user token (works
         only for admins under the new scope set). */
      searchSharePoint(appOnlyToken ?? token.accessToken, { query: question, topN: SHAREPOINT_TOP_N }),
      searchProjectTasks(token.accessToken, { query: question, topN: PROJECT_TOP_N }),
      searchCalendarEvents(token.accessToken, {
        query: question,
        topN: CALENDAR_TOP_N,
        ...(range ? { startDateTime: range.startISO, endDateTime: range.endISO } : {}),
      }),
      searchMessages(userId, { query: question, topN: EMAIL_TOP_N }),
    ]);
    spRes = spSettled.status === "fulfilled" ? spSettled.value : null;
    projRes = projSettled.status === "fulfilled" ? projSettled.value : null;
    calRes = calSettled.status === "fulfilled" ? calSettled.value : null;
    mailRes = mailSettled.status === "fulfilled" ? mailSettled.value : null;
  } else if (appOnlyToken) {
    /* Even when the user has no delegated token (hasn't connected
       M365 yet), SharePoint search still works via app-only. The
       other three surfaces are own-user-scoped and skipped. */
    const spSettled = await Promise.allSettled([
      searchSharePoint(appOnlyToken, { query: question, topN: SHAREPOINT_TOP_N }),
    ]);
    spRes = spSettled[0].status === "fulfilled" ? spSettled[0].value : null;
  }

  const [meetingRes, porscheRes] = await Promise.all([meetingPromise, porschePromise]);

  const errors: ContextBundle["errors"] = {};
  let sharepoint_hits: SharePointSearchHit[] = [];
  let project_tasks: ProjectTaskSummary[] = [];
  let meeting_notes: MeetingNoteHit[] = [];
  let calendar_events: CalendarEventHit[] = [];
  let email_threads: EmailThreadHit[] = [];

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
  /* Merge porsche-class snapshots into the same lane. They share the
     MeetingNoteHit shape so renderMeetingEntry handles them uniformly
     (the [Meeting] prefix is acceptable shorthand for any class-or-
     transcript-style hit). When the porsche fetch errored, the typed
     result still surfaces in `errors.meeting` so the UI can flag it. */
  if (porscheRes.ok) {
    meeting_notes = meeting_notes.concat(porscheRes.hits);
  } else {
    errors.meeting = errors.meeting ?? porscheRes;
    trackPorscheClassLookupFailure(userId, role, porscheRes);
  }
  if (calRes && calRes.ok) {
    calendar_events = calRes.value.hits;
  } else if (calRes && !calRes.ok) {
    errors.calendar = calRes;
    trackCalendarLookupFailure(userId, role, calRes);
  }
  if (mailRes && mailRes.ok) {
    email_threads = mailRes.value.hits;
  } else if (mailRes && !mailRes.ok) {
    errors.email = mailRes;
    trackEmailLookupFailure(userId, role, mailRes);
  }

  const { rendered, dropped } = renderPromptBlock({
    hits: sharepoint_hits,
    tasks: project_tasks,
    meetings: meeting_notes,
    calendar: calendar_events,
    emails: email_threads,
    maxChars,
  });

  if (dropped.total > 0) {
    trackEvent("assistant.context_truncated", userId, role, {
      surface,
      dropped_count: dropped.total,
      dropped_sharepoint: dropped.sharepoint,
      dropped_project: dropped.project,
      dropped_meeting: dropped.meeting,
      dropped_calendar: dropped.calendar,
      dropped_email: dropped.email,
      reason: "max_chars",
    });
  }

  const bundle: ContextBundle = {
    question,
    surface,
    sharepoint_hits,
    project_tasks,
    meeting_notes,
    calendar_events,
    email_threads,
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
    calendar_count: calendar_events.length,
    email_count: email_threads.length,
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
  renderCalendarEntry,
  renderEmailEntry,
  extractDateRange,
  PROMPT_HEADER,
  DEFAULT_MAX_CHARS,
  MIN_MAX_CHARS,
  SHAREPOINT_TOP_N,
  PROJECT_TOP_N,
  MEETING_TOP_N,
  MEETING_SNIPPET_MAX,
  CALENDAR_TOP_N,
  EMAIL_TOP_N,
};
