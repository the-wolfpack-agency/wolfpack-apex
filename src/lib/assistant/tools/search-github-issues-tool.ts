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
/** Words that follow "in/for/on" and are never a repository name. */
const GENERIC_REPO_WORD = /^(?:repo|repos|repository|repositories|project|projects)$/i;
const LABEL_RE = /\blabel(?:ed|led)?\s+(?:as\s+)?["']?([\w-]{1,40})["']?/i;

const BUG_LABEL_HINTS = /\b(bug|bugs|defects?)\b/i;
const URGENT_LABEL_HINTS = /\b(urgent|priority|p0|p1|critical)\b/i;

function matchIssueIntent(message: string): Params | null {
  const trimmed = message.trim();
  /* REPORTING A BUG IS NOT SEARCHING FOR ONE.
     "report a bug" contains the word bug, which satisfies both the
     keyword requirement and the label hint below, so this tool claimed
     it. It is registered at position 36 and the feedback tool at 53, so
     it won: somebody telling us something was broken was shown a list of
     other people's issues.
     The verbs are the whole difference. Report, log, raise and file are
     somebody handing us something; find, show and search are somebody
     looking. */
  if (/\b(?:report|log|raise|file|submit)\s+(?:an?\s+)?(?:bug|issue|defect|problem)\b/i.test(trimmed)) {
    return null;
  }
  /* PR phrases belong to the PR tool. */
  if (/\b(?:pull\s+requests?|pull-requests?|prs?)\b/i.test(trimmed)) return null;
  /* Require an "issue" / "ticket" / "bug" keyword. "ticket" overlaps
     with Zendesk/Jira but neither is registered yet — when they land we
     reorder. */
  /* "the backlog" IS the issue list here, and carries none of these words. */
  if (!/\b(?:issues?|tickets?|bugs?|backlog)\b/i.test(trimmed)) return null;
  /* Defensive: "GitHub" / "gh" anchor reduces false-positive vs.
     "any issues with the deploy" style chatter. We DON'T require it
     when "label/labeled" appears (a strong GitHub-y signal). */
  const isExplicitGithub = /\b(?:github|gh)\b/i.test(trimmed);
  const hasLabelHint = /\blabel(?:ed|led)?\b/i.test(trimmed) || BUG_LABEL_HINTS.test(trimmed) || URGENT_LABEL_HINTS.test(trimmed);
  /* "for the repo" ends the sentence, so `repo\s+` never matched it. */
  const hasRepoHint = /\b(?:repos?\b|wolfpack-|the-wolfpack-agency)/i.test(trimmed);

  /* SHAPES THAT ARE ONLY EVER ABOUT A TRACKER.
   *
   * The github/gh anchor exists to keep "any issues with the deploy" out, and
   * it is right to. But it also kept out the four commonest ways anybody asks
   * for their issue list - found by scripts/phrase-sweep.ts, all four reaching
   * a model that cannot see GitHub.
   *
   * These are narrower than the anchor rather than looser: "open issues" as a
   * phrase, or work assigned to a person, or the backlog. "any issues with the
   * deploy" matches none of them, because the discriminator is the noun phrase
   * and not the word "issues" on its own. */
  const trackerShape =
    /\b(?:open|closed)\s+(?:issues?|tickets?|bugs?)\b/i.test(trimmed) ||
    /\bbacklog\b/i.test(trimmed);

  /* NOT "ASSIGNED TO ME", and this is the interesting one.
   *
   * The sweep lists it as a miss and it is tempting, because it is obviously
   * about GitHub. But this client filters by AUTHOR, not assignee, and there
   * is no mapping from an Instinct user to a GitHub login. Claiming the phrase
   * would answer "what is assigned to me" with every open issue in the org -
   * confidently, and wrongly, which is worse than the model call it replaces.
   *
   * It stays a miss until there is an assignee filter and an identity to put
   * in it. A phrasing we cannot answer correctly is not a phrasing to take. */

  if (!isExplicitGithub && !hasLabelHint && !hasRepoHint && !trackerShape) return null;

  const params: Params = {};

  if (/\bopen\b/i.test(trimmed)) params.state = "open";
  else if (/\b(?:closed|resolved)\b/i.test(trimmed)) params.state = "closed";
  else params.state = "open"; // sensible default

  const repoMatch = REPO_RE.exec(trimmed);
  /* "for the repo" IS NOT A REPO NAMED "repo". REPO_RE takes the word after
     in/for/on/from, so a generic noun becomes a repository that does not
     exist, and the search returns an empty list rather than the org-wide
     answer the person asked for. Falling through to the org is correct here:
     they said "the repo" precisely because they did not name one. */
  if (repoMatch && !GENERIC_REPO_WORD.test(repoMatch[1])) params.repo = repoMatch[1];

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
  /* Identifier clicks out to the issue on GitHub. */
  return `[${issue.repo}#${issue.number}](${issue.html_url}) — **${issue.title}** (@${issue.user})${labelTag}`;
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
    const stateLabel = params.state ?? "open";
    const scope = params.repo ? ` in ${params.repo}` : "";
    return {
      ok: true,
      data: {
        connector: "github",
        matchCount: result.data.length,
        issues: result.data,
      },
      answer: withSourceFooter(renderAnswer(params, result.data), "github"),
      widget: {
        kind: "github_items",
        itemKind: "issue",
        title:
          result.data.length === 0
            ? `No ${stateLabel} issues${scope}`
            : `${result.data.length} ${stateLabel} issue${result.data.length === 1 ? "" : "s"}${scope}`,
        items: result.data.map((iss) => ({
          id: `${iss.repo}#${iss.number}`,
          kind: "issue",
          number: iss.number,
          title: iss.title,
          state: iss.state,
          user: iss.user,
          repo: iss.repo,
          url: iss.html_url,
          labels: iss.labels,
          createdAt: iss.created_at,
          updatedAt: iss.updated_at,
        })),
      },
    };
  },
};

registerTool(searchGithubIssuesTool);
