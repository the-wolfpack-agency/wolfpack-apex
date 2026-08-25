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
import { knownRepos, askWhichRepo, whichRepoWidget } from "./github-repos";
import { withSourceFooter } from "./source-footer";
import {
  recentWorkflowRuns,
  type WorkflowRunSummary,
} from "./github-query-client";

const STATUS_VALUES = ["success", "failure", "in_progress", "queued", "cancelled"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

const ParamSchema = z.object({
  /* OPTIONAL, because "is CI green" is a real question and does not name one.
     Absent, the tool asks which repo instead of guessing, which costs nothing
     and cannot be wrong. See matchWorkflowIntent. */
  repo: z.string().min(1).max(140).optional(),
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
    /\b(?:workflow\s+runs?|actions?\s+runs?|ci\s+runs?|workflow|github\s+actions?|gh\s+actions?|actions?\b|ci\b|build|builds|tests?)\b/i.test(trimmed);
  if (!isWorkflowAsk) return null;
  /* "green build" / "is the build passing" → success filter */
  /* "failed CI" / "broken build" → failure filter */

  const repoMatch = REPO_RE.exec(trimmed);

  /* NO REPO NAMED IS STILL A QUESTION ABOUT THE BUILD.
   *
   * This returned null, so "is CI green", "are the tests passing" and "did the
   * build pass" all fell through - the first two to a model, and the third to
   * the Vercel deployments widget, which answered a question about CI with a
   * list of deploys. Found by scripts/phrase-sweep.ts.
   *
   * THE REPO REQUIREMENT WAS ALSO DOING A SECOND JOB, and dropping it without
   * noticing would have been the bug. The keyword gate above accepts the bare
   * word "build", so "build me a report for the board" satisfies it; the
   * explicit repo was the only thing standing between that and this tool.
   *
   * So the gate is stricter when no repo is named: a real CI word, or "build"
   * and "tests" paired with an outcome. Asking about a build's RESULT is a
   * different sentence from asking somebody to build something. */
  const namesRepo = Boolean(repoMatch);
  if (!namesRepo) {
    const explicitCi = /\b(?:ci|workflow|workflows|github\s+actions?|gh\s+actions?|pipeline)\b/i.test(trimmed);
    const outcome = /\b(?:pass(?:ed|ing)?|fail(?:ed|ing)?|green|red|broken|succeed(?:ed|ing)?|status)\b/i.test(trimmed);
    const buildOrTests = /\b(?:builds?|tests?)\b/i.test(trimmed);
    if (!explicitCi && !(buildOrTests && outcome)) return null;
  }

  const params: Params = repoMatch ? { repo: repoMatch[1] } : {};

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
    /* ASK, DO NOT GUESS.
     *
     * There is no default repo in this codebase and inventing one here would
     * mean answering "is CI green" confidently about a repository nobody
     * mentioned. The repos the workspace already manages are on record, so
     * the question can name them and be answered with a click rather than a
     * paragraph. Zero tokens either way, which is the point: this replaces a
     * model call that could not have known the answer either. */
    if (!params.repo) {
      const known = await knownRepos();
      trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
        tool: "recent_workflow_runs",
        ok: true,
        match_count: 0,
        /* How often people ask about the build without naming a repo. If this
           stays high, the answer is a default repo setting, not a wider
           regex. */
        repo: "unspecified",
        status: params.status ?? "any",
      });
      const example = (repo: string) => `is the build green for ${repo}`;
      const widget = whichRepoWidget(ctx.message ?? "is the build green", known, example);
      return {
        ok: true,
        data: { connector: "github", repo: "", matchCount: 0, runs: [] },
        answer: askWhichRepo(known, example),
        /* One tap instead of retyping the whole question. */
        ...(widget ? { widget } : {}),
      };
    }

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
        repo: params.repo ?? "",
        matchCount: result.data.length,
        runs: result.data,
      },
      answer: withSourceFooter(renderAnswer(params, result.data), "github"),
    };
  },
};

registerTool(recentWorkflowRunsTool);
