/**
 * search_github_pull_requests — list PRs across the org or a single repo.
 *
 * Intent patterns:
 *   "what PRs are open"                    → state=open, org-wide
 *   "open pull requests"                   → state=open, org-wide
 *   "PRs in wolfpack-apex"                 → repo=wolfpack-apex
 *   "open PRs in wolfpack-auto"            → repo=wolfpack-auto, state=open
 *   "closed PRs by nhomyk"                 → state=closed, author=nhomyk
 *   "show recent pull requests"            → state defaults to open
 *
 * Why GitHub doesn't go through the CRM connector framework: the data
 * model is fundamentally different (no Contacts/Deals/Accounts — it's
 * PRs/Issues/Workflows). Routing through the vendor-preset abstraction
 * would mean inventing fake CRM-shaped objects for PRs, which leaks the
 * abstraction. A purpose-built tool stays honest.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { withSourceFooter } from "./source-footer";
import {
  searchPullRequests,
  type PullRequestSummary,
} from "./github-query-client";

const ParamSchema = z.object({
  state: z.enum(["open", "closed"]).optional(),
  repo: z.string().min(1).max(140).optional(),
  author: z.string().min(1).max(60).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface SearchGithubPRsData {
  connector: "github";
  matchCount: number;
  pullRequests: PullRequestSummary[];
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

const REPO_RE =
  /\b(?:in|for|on|from)\s+(?:repo\s+|the\s+)?([a-z0-9][\w-]*(?:\/[\w.-]+)?)\b/i;
const AUTHOR_RE = /\bby\s+@?([\w-]{1,60})\b/i;

function matchPRIntent(message: string): Params | null {
  const trimmed = message.trim();
  /* The phrase "pull request" / "PR" must be present — otherwise this
     tool can capture stuff like "PR firm" (Wolfpack Agency is a PR firm
     in some clients' minds). Strict on the keyword. */
  if (!/\b(?:pull\s+requests?|pull-requests?|prs?)\b/i.test(trimmed)) return null;
  /* Avoid false-positive on the word "press" (PR firm parlance) which
     would otherwise match the loose [pP][rR] regex. */
  if (/\bpress\b/i.test(trimmed) && !/\b(?:pull\s+requests?|pull-requests?|prs?)\b/i.test(trimmed)) {
    return null;
  }

  const params: Params = {};

  if (/\bopen\b/i.test(trimmed)) params.state = "open";
  else if (/\b(?:closed|merged)\b/i.test(trimmed)) params.state = "closed";

  const repoMatch = REPO_RE.exec(trimmed);
  if (repoMatch) params.repo = repoMatch[1];

  const authorMatch = AUTHOR_RE.exec(trimmed);
  if (authorMatch) params.author = authorMatch[1];

  /* Default: if the user said "PRs" with no state qualifier, they
     almost always mean OPEN. Closed PRs are noise without an explicit
     ask. */
  if (!params.state) params.state = "open";

  return params;
}

/* ---------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------- */

function renderOnePr(pr: PullRequestSummary): string {
  const draftTag = pr.draft ? " 🚧" : "";
  /* Title clicks straight to the PR on GitHub. Repo+number stays as
   * the leading identifier (familiar shape) but also wraps in the
   * link so either click lands in the same place. */
  return `[${pr.repo}#${pr.number}](${pr.html_url}) — **${pr.title}**${draftTag} (@${pr.user})`;
}

function renderAnswer(p: Params, prs: PullRequestSummary[]): string {
  const stateLabel = p.state ?? "open";
  const scope = p.repo ? ` in \`${p.repo}\`` : "";
  const authorScope = p.author ? ` by @${p.author}` : "";
  if (prs.length === 0) {
    return `No ${stateLabel} pull requests${scope}${authorScope}.`;
  }
  const head =
    prs.length > 5
      ? `Found ${prs.length}+ ${stateLabel} pull requests${scope}${authorScope}. Top 5:`
      : `Found ${prs.length} ${stateLabel} pull request${prs.length === 1 ? "" : "s"}${scope}${authorScope}:`;
  const top = prs.slice(0, 5);
  const list = top
    .map((pr, i) => `${i + 1}. ${renderOnePr(pr)}`)
    .join("\n");
  return `${head}\n\n${list}`;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const searchGithubPullRequestsTool: ToolDef<Params, SearchGithubPRsData> = {
  name: "search_github_pull_requests",
  description:
    "List GitHub pull requests across the org or a specific repo. Supports state (open/closed), repo, and author filters.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchPRIntent,
  async handler(params, ctx): Promise<ToolResult<SearchGithubPRsData>> {
    const result = await searchPullRequests({
      state: params.state,
      repo: params.repo,
      author: params.author,
      perPage: 10,
    });
    if (!result.ok) {
      trackEvent("assistant.github_query_executed", ctx.userId, ctx.userRole, {
        tool: "search_github_pull_requests",
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
      tool: "search_github_pull_requests",
      ok: true,
      match_count: result.data.length,
      duration_ms: result.durationMs,
      repo: params.repo ?? "",
      state: params.state ?? "open",
    });
    const stateLabel = params.state ?? "open";
    const scope = params.repo ? ` in ${params.repo}` : "";
    const authorScope = params.author ? ` by @${params.author}` : "";
    return {
      ok: true,
      data: {
        connector: "github",
        matchCount: result.data.length,
        pullRequests: result.data,
      },
      answer: withSourceFooter(renderAnswer(params, result.data), "github"),
      widget: {
        kind: "github_items",
        itemKind: "pull_request",
        title:
          result.data.length === 0
            ? `No ${stateLabel} pull requests${scope}${authorScope}`
            : `${result.data.length} ${stateLabel} pull request${result.data.length === 1 ? "" : "s"}${scope}${authorScope}`,
        items: result.data.map((pr) => ({
          id: `${pr.repo}#${pr.number}`,
          kind: "pull_request",
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          user: pr.user,
          repo: pr.repo,
          url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
        })),
      },
    };
  },
};

registerTool(searchGithubPullRequestsTool);
