/**
 * recent_workflow_runs — list recent GitHub Actions runs for a repo.
 *
 * Intent patterns:
 *   "recent workflow runs in wolfpack-apex"     → repo=...
 *   "show me failed CI runs in wolfpack-auto"   → status=failure, repo=...
 *   "is the build green for wolfpack-apex"      → repo=..., status=success
 *   "what failed in actions for repo X"         → repo=X, status=failure
 *
 * Repo is REQUIRED (GitHub has no "list runs across org" endpoint
 * without enumerating repos — we don't want to fan out from the
 * assistant in a tight loop). If the user doesn't specify, ask.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { withSourceFooter } from "./source-footer";
import {
  recentWorkflowRuns,
  type WorkflowRunSummary,
} from "./github-query-client";

const STATUS_VALUES = ["success", "failure", "in_progress", "queued", "cancelled"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

const ParamSchema = z.object({
  repo: z.string().min(1).max(140),
  status: z.enum(STATUS_VALUES).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface RecentWorkflowRunsData {
  connector: "github";
  repo: string;
  matchCount: number;
  runs: WorkflowRunSummary[];
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

const REPO_RE =
  /\b(?:in|for|on|from)\s+(?:repo\s+|the\s+)?([a-z0-9][\w-]*(?:\/[\w.-]+)?)\b/i;

function matchWorkflowIntent(message: string): Params | null {
  const trimmed = message.trim();
  /* Require an actions/workflow/CI/build keyword. */
  const isWorkflowAsk =
    /\b(?:workflow\s+runs?|actions?\s+runs?|ci\s+runs?|workflow|github\s+actions?|gh\s+actions?|actions?\b|ci\b|build|builds)\b/i.test(trimmed);
  if (!isWorkflowAsk) return null;
  /* "green build" / "is the build passing" → success filter */
  /* "failed CI" / "broken build" → failure filter */

  const repoMatch = REPO_RE.exec(trimmed);
  if (!repoMatch) return null; // require an explicit repo

  const params: Params = { repo: repoMatch[1] };

  if (/\b(?:failed|failure|failing|broken|red)\b/i.test(trimmed)) params.status = "failure";
  else if (/\b(?:green|passing|succeeded|successful|success)\b/i.test(trimmed)) params.status = "success";
  else if (/\b(?:in[\s-]?progress|running|active)\b/i.test(trimmed)) params.status = "in_progress";
  else if (/\b(?:queued|pending|waiting)\b/i.test(trimmed)) params.status = "queued";
  else if (/\b(?:cancell?ed)\b/i.test(trimmed)) params.status = "cancelled";

  return params;
}

/* ---------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------- */

function statusEmoji(run: WorkflowRunSummary): string {
  if (run.status !== "completed") {
    if (run.status === "in_progress") return "⏳";
    if (run.status === "queued") return "🕒";
    return run.status;
  }
  switch (run.conclusion) {
    case "success": return "✅";
    case "failure": return "❌";
    case "cancelled": return "🚫";
    case "skipped": return "⏭️";
    default: return run.conclusion ?? "?";
  }
}

function renderOneRun(run: WorkflowRunSummary): string {
  const branch = run.head_branch ? `\`${run.head_branch}\`` : "";
  const event = run.event ? ` · ${run.event}` : "";
  /* Name clicks out to the run summary page on GitHub Actions
   * (logs + jobs + re-run button). */
  return `${statusEmoji(run)} [**${run.name}**](${run.html_url}) ${branch}${event} (@${run.actor})`;
}

function renderAnswer(p: Params, runs: WorkflowRunSummary[]): string {
  const statusScope = p.status ? ` (${p.status})` : "";
  if (runs.length === 0) {
    return `No workflow runs${statusScope} for \`${p.repo}\`.`;
  }
  const head =
    runs.length > 5
      ? `Recent ${runs.length}+ workflow runs${statusScope} in \`${p.repo}\`. Top 5:`
      : `Recent ${runs.length} workflow run${runs.length === 1 ? "" : "s"}${statusScope} in \`${p.repo}\`:`;
  const top = runs.slice(0, 5);
  const list = top
    .map((r, i) => `${i + 1}. ${renderOneRun(r)}`)
    .join("\n");
  return `${head}\n\n${list}`;
}

export const recentWorkflowRunsTool: ToolDef<Params, RecentWorkflowRunsData> = {
  name: "recent_workflow_runs",
  description:
    "List recent GitHub Actions workflow runs for a specific repo. Supports status filter (success/failure/in_progress/queued/cancelled).",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchWorkflowIntent,
  async handler(params, ctx): Promise<ToolResult<RecentWorkflowRunsData>> {
    const result = await recentWorkflowRuns({
      repo: params.repo,
      status: params.status,
      perPage: 10,
    });
    if (!result.ok) {
      trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
        tool: "recent_workflow_runs",
        ok: false,
        code: result.code,
        repo: params.repo,
      });
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message: result.message,
      };
    }
    trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
      tool: "recent_workflow_runs",
      ok: true,
      match_count: result.data.length,
      duration_ms: result.durationMs,
      repo: params.repo,
      status: params.status ?? "any",
    });
    return {
      ok: true,
      data: {
        connector: "github",
        repo: params.repo,
        matchCount: result.data.length,
        runs: result.data,
      },
      answer: withSourceFooter(renderAnswer(params, result.data), "github"),
    };
  },
};

registerTool(recentWorkflowRunsTool);
