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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContextSurface = "knowledge" | "assistant_support";

export interface ContextBundle {
  question: string;
  surface: ContextSurface;
  sharepoint_hits: SharePointSearchHit[];
  project_tasks: ProjectTaskSummary[];
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

// ---------------------------------------------------------------------------
// Rendering — prompt block formatting
// ---------------------------------------------------------------------------

interface RenderableEntry {
  /** Stable index used to break ties when sorting by length. */
  ix: number;
  /** Source kind for analytics + truncation telemetry. */
  source: "sharepoint" | "project";
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

const PROMPT_HEADER = "Internal context (cite if you use it):\n\n";

/**
 * Build the rendered prompt block. Truncates entries (longest first) to
 * keep the result <= maxChars. Returns the rendered string + a count of
 * how many entries were dropped per source.
 */
export function renderPromptBlock(
  hits: SharePointSearchHit[],
  tasks: ProjectTaskSummary[],
  maxChars: number,
): {
  rendered: string;
  dropped: { sharepoint: number; project: number; total: number };
} {
  const cap = Math.max(MIN_MAX_CHARS, maxChars);
  const entries: RenderableEntry[] = [
    ...hits.map((h, i) => renderSharePointEntry(h, i)),
    ...tasks.map((t, i) => renderProjectEntry(t, i + hits.length)),
  ];

  // Total length budget = cap minus the header.
  const budget = cap - PROMPT_HEADER.length;
  if (budget < 0) {
    // Caller passed an absurdly small cap. Return just the header.
    return {
      rendered: PROMPT_HEADER.slice(0, cap),
      dropped: { sharepoint: hits.length, project: tasks.length, total: hits.length + tasks.length },
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
  for (const e of entries) {
    if (kept.has(e.ix)) continue;
    if (e.source === "sharepoint") droppedSp += 1;
    else droppedProj += 1;
  }
  return {
    rendered,
    dropped: {
      sharepoint: droppedSp,
      project: droppedProj,
      total: droppedSp + droppedProj,
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
      rendered_prompt_block: rendered,
      total_chars: rendered.length,
      took_ms: Date.now() - t0,
      ...(errors ? { errors } : {}),
    };
    trackEvent("assistant.context_resolved", userId, role, {
      surface,
      sharepoint_count: 0,
      project_count: 0,
      total_chars: rendered.length,
      took_ms: bundle.took_ms,
    });
    return bundle;
  };

  if (!question) return empty();

  const token = await getValidToken(userId);
  if (!token) {
    return empty();
  }

  // Parallel surface fan-out — both helpers never throw, so Promise.all is
  // safe.
  const [spRes, projRes] = await Promise.all([
    searchSharePoint(token.accessToken, { query: question, topN: SHAREPOINT_TOP_N }),
    searchProjectTasks(token.accessToken, { query: question, topN: PROJECT_TOP_N }),
  ]);

  const errors: ContextBundle["errors"] = {};
  let sharepoint_hits: SharePointSearchHit[] = [];
  let project_tasks: ProjectTaskSummary[] = [];

  if (spRes.ok) {
    sharepoint_hits = spRes.value.hits;
  } else {
    errors.sharepoint = spRes;
    trackSharePointLookupFailure(userId, role, spRes);
  }
  if (projRes.ok) {
    project_tasks = projRes.value.tasks;
  } else {
    errors.project = projRes;
    trackProjectLookupFailure(userId, role, projRes);
  }

  const { rendered, dropped } = renderPromptBlock(sharepoint_hits, project_tasks, maxChars);

  if (dropped.total > 0) {
    trackEvent("assistant.context_truncated", userId, role, {
      surface,
      dropped_count: dropped.total,
      dropped_sharepoint: dropped.sharepoint,
      dropped_project: dropped.project,
      reason: "max_chars",
    });
  }

  const bundle: ContextBundle = {
    question,
    surface,
    sharepoint_hits,
    project_tasks,
    rendered_prompt_block: rendered,
    total_chars: rendered.length,
    took_ms: Date.now() - t0,
    ...(Object.keys(errors).length ? { errors } : {}),
  };

  trackEvent("assistant.context_resolved", userId, role, {
    surface,
    sharepoint_count: sharepoint_hits.length,
    project_count: project_tasks.length,
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
  PROMPT_HEADER,
  DEFAULT_MAX_CHARS,
  MIN_MAX_CHARS,
  SHAREPOINT_TOP_N,
  PROJECT_TOP_N,
};
