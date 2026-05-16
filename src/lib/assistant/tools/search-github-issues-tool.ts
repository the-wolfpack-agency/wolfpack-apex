/**
 * search_github_issues — list issues across the org or a single repo.
 *
 * Intent patterns:
 *   "what issues are open"                  → state=open, org-wide
 *   "open issues in wolfpack-apex"          → repo=..., state=open
 *   "closed issues by nhomyk"               → state=closed, author=...
 *   "bug issues in wolfpack-auto"           → label=bug, repo=...
 *   "show me issues labeled urgent"         → label=urgent
 *
 * Registered AFTER search_github_pull_requests in the dispatcher
 * cascade — "pull request" claims its phrase first; "issues" is the
 * fallback for any GitHub-ticket-style ask.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { withSourceFooter } from "./source-footer";
import {
  searchIssues,
  type IssueSummary,
} from "./github-query-client";

const ParamSchema = z.object({
  state: z.enum(["open", "closed"]).optional(),
  repo: z.string().min(1).max(140).optional(),
  label: z.string().min(1).max(60).optional(),
  author: z.string().min(1).max(60).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface SearchGithubIssuesData {
  connector: "github";
  matchCount: number;
  issues: IssueSummary[];
}

/* ---------------------------------------------------------------------
 * Intent matching
 *
 * NOTE: tools are registered after search_github_pull_requests, so when
 * a message has BOTH "pull request" and "issue" the PR tool wins. We
 * still reject explicit "PR" / "pull request" phrasing defensively
 * here, since users who type "issues with PR #42" expect the PR tool.
 * ------------------------------------------------------------------- */

const REPO_RE =
  /\b(?:in|for|on|from)\s+(?:repo\s+|the\s+)?([a-z0-9][\w-]*(?:\/[\w.-]+)?)\b/i;
const AUTHOR_RE = /\bby\s+@?([\w-]{1,60})\b/i;
const LABEL_RE = /\blabel(?:ed|led)?\s+(?:as\s+)?["']?([\w-]{1,40})["']?/i;

const BUG_LABEL_HINTS = /\b(bug|bugs|defects?)\b/i;
const URGENT_LABEL_HINTS = /\b(urgent|priority|p0|p1|critical)\b/i;

function matchIssueIntent(message: string): Params | null {
  const trimmed = message.trim();
  /* PR phrases belong to the PR tool. */
  if (/\b(?:pull\s+requests?|pull-requests?|prs?)\b/i.test(trimmed)) return null;
  /* Require an "issue" / "ticket" / "bug" keyword. "ticket" overlaps
     with Zendesk/Jira but neither is registered yet — when they land we
     reorder. */
  if (!/\b(?:issues?|tickets?|bugs?)\b/i.test(trimmed)) return null;
  /* Defensive: "GitHub" / "gh" anchor reduces false-positive vs.
     "any issues with the deploy" style chatter. We DON'T require it
     when "label/labeled" appears (a strong GitHub-y signal). */
  const isExplicitGithub = /\b(?:github|gh)\b/i.test(trimmed);
  const hasLabelHint = /\blabel(?:ed|led)?\b/i.test(trimmed) || BUG_LABEL_HINTS.test(trimmed) || URGENT_LABEL_HINTS.test(trimmed);
  const hasRepoHint = /\b(?:repo\s+|wolfpack-|the-wolfpack-agency)/i.test(trimmed);
  if (!isExplicitGithub && !hasLabelHint && !hasRepoHint) return null;

  const params: Params = {};

  if (/\bopen\b/i.test(trimmed)) params.state = "open";
  else if (/\b(?:closed|resolved)\b/i.test(trimmed)) params.state = "closed";
  else params.state = "open"; // sensible default

  const repoMatch = REPO_RE.exec(trimmed);
  if (repoMatch) params.repo = repoMatch[1];

  const authorMatch = AUTHOR_RE.exec(trimmed);
  if (authorMatch) params.author = authorMatch[1];

  const labelMatch = LABEL_RE.exec(trimmed);
  if (labelMatch) params.label = labelMatch[1];
  else if (BUG_LABEL_HINTS.test(trimmed) && !/\bissues?\b.*\bbugs?\b/i.test(trimmed)) {
    /* "bug issues in repo X" → label=bug. But "issues about a bug" is
       not a label assertion. We only label when "bug" is the leading
       descriptor. */
    if (/^\s*(?:open\s+|closed\s+)?bugs?\b/i.test(trimmed)) params.label = "bug";
  }

  return params;
}

/* ---------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------- */

function renderOneIssue(issue: IssueSummary): string {
  const labelTag = issue.labels.length > 0 ? ` [${issue.labels.slice(0, 3).join(", ")}]` : "";
  return `${issue.repo}#${issue.number} — **${issue.title}** (@${issue.user})${labelTag}`;
}

function renderAnswer(p: Params, issues: IssueSummary[]): string {
  const stateLabel = p.state ?? "open";
  const scope = p.repo ? ` in \`${p.repo}\`` : "";
  const labelScope = p.label ? ` labeled \`${p.label}\`` : "";
  const authorScope = p.author ? ` by @${p.author}` : "";
  if (issues.length === 0) {
    return `No ${stateLabel} issues${scope}${labelScope}${authorScope}.`;
  }
  const head =
    issues.length > 5
      ? `Found ${issues.length}+ ${stateLabel} issues${scope}${labelScope}${authorScope}. Top 5:`
      : `Found ${issues.length} ${stateLabel} issue${issues.length === 1 ? "" : "s"}${scope}${labelScope}${authorScope}:`;
  const top = issues.slice(0, 5);
  const list = top
    .map((it, i) => `${i + 1}. ${renderOneIssue(it)}`)
    .join("\n");
  return `${head}\n\n${list}`;
}

export const searchGithubIssuesTool: ToolDef<Params, SearchGithubIssuesData> = {
  name: "search_github_issues",
  description:
    "List GitHub issues across the org or a specific repo. Supports state (open/closed), repo, label, and author filters.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchIssueIntent,
  async handler(params, ctx): Promise<ToolResult<SearchGithubIssuesData>> {
    const result = await searchIssues({
      state: params.state,
      repo: params.repo,
      label: params.label,
      author: params.author,
      perPage: 10,
    });
    if (!result.ok) {
      trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
        tool: "search_github_issues",
        ok: false,
        code: result.code,
        repo: params.repo ?? "",
      });
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message: result.message,
      };
    }
    trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
      tool: "search_github_issues",
      ok: true,
      match_count: result.data.length,
      duration_ms: result.durationMs,
      repo: params.repo ?? "",
      state: params.state ?? "open",
    });
    return {
      ok: true,
      data: {
        connector: "github",
        matchCount: result.data.length,
        issues: result.data,
      },
      answer: withSourceFooter(renderAnswer(params, result.data), "github"),
    };
  },
};

registerTool(searchGithubIssuesTool);
