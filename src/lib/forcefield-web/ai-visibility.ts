/**
 * AI visibility: which AI agents and search engines read ONE site, what they read,
 * how often, and whether each was really who it claimed to be.
 *
 * The "Who visited" list (tenant-activity.ts) answers "what did each bot do and how
 * did Forcefield handle it". This answers the question every site owner now has
 * about AI: is my site being read for AI training, for AI search answers, or by an
 * assistant acting for a person, and which pages? Grouped by PURPOSE from each
 * vendor's own documentation (AGENT_PURPOSE), with identity checks the engine
 * already records:
 *   verified       the request came from the vendor's published IP ranges, or a
 *                  Web Bot Auth signature verified (web-bot-auth.ts)
 *   impersonation  the user-agent claimed the agent but the request came from
 *                  outside its published ranges (flagged, not welcomed)
 *   unverified     the vendor publishes nothing we can check against
 *
 * Counts only, scoped to one tenant (forcefield_tenant_id) or, for our own
 * internal sites that are not tenants, one site label. Paths are the site's own
 * public pages (no query strings are stored). Synthetic traffic is excluded.
 * Injectable query; never throws (degrades to empty). Decoy and repeat rows carry
 * repeat_count (EVENT_WEIGHT_SQL), so requests are summed, not counted.
 */
import { safeQuery } from "@/lib/db";
import { EVENT_WEIGHT_SQL } from "@/lib/site-analytics-weight";

export type AgentPurpose = "ai_training" | "ai_search" | "ai_assistant" | "search_engine";

/** What each known agent is for, per its vendor's documentation. An agent missing
 *  here is shown as "other" (never guessed). */
export const AGENT_PURPOSE: Readonly<Record<string, { purpose: AgentPurpose; vendor: string }>> = {
  GPTBot: { purpose: "ai_training", vendor: "OpenAI" },
  "OAI-SearchBot": { purpose: "ai_search", vendor: "OpenAI" },
  "ChatGPT-User": { purpose: "ai_assistant", vendor: "OpenAI" },
  "chatgpt.com": { purpose: "ai_assistant", vendor: "OpenAI" },
  ClaudeBot: { purpose: "ai_training", vendor: "Anthropic" },
  "Claude-SearchBot": { purpose: "ai_search", vendor: "Anthropic" },
  "Claude-User": { purpose: "ai_assistant", vendor: "Anthropic" },
  PerplexityBot: { purpose: "ai_search", vendor: "Perplexity" },
  "Perplexity-User": { purpose: "ai_assistant", vendor: "Perplexity" },
  "MistralAI-User": { purpose: "ai_assistant", vendor: "Mistral" },
  DuckAssistBot: { purpose: "ai_search", vendor: "DuckDuckGo" },
  "Google-CloudVertexBot": { purpose: "ai_assistant", vendor: "Google" },
  "Meta-ExternalAgent": { purpose: "ai_training", vendor: "Meta" },
  "Meta-ExternalFetcher": { purpose: "ai_assistant", vendor: "Meta" },
  Bytespider: { purpose: "ai_training", vendor: "ByteDance" },
  Amazonbot: { purpose: "ai_search", vendor: "Amazon" },
  Googlebot: { purpose: "search_engine", vendor: "Google" },
  Bingbot: { purpose: "search_engine", vendor: "Microsoft" },
  Applebot: { purpose: "search_engine", vendor: "Apple" },
  DuckDuckBot: { purpose: "search_engine", vendor: "DuckDuckGo" },
};

export const PURPOSE_LABEL: Readonly<Record<AgentPurpose | "other", string>> = {
  ai_training: "AI training",
  ai_search: "AI search answers",
  ai_assistant: "AI assistants acting for a person",
  search_engine: "Search engines",
  other: "Other agents",
};

export type Identity = "verified" | "impersonation" | "unverified";

export interface AiAgentVisibility {
  agent: string;
  vendor: string | null;
  purpose: AgentPurpose | "other";
  /** Requests the real agent made (welcomed). */
  requests: number;
  /** Of those, how many had their identity checked and confirmed (published IP
   *  ranges or a verified signature). Older events predate the check. */
  verifiedRequests: number;
  /** Requests that CLAIMED this agent from outside its published ranges. */
  impersonations: number;
  /** Of `requests`, how many the site's own policy turned away (agent-policy.ts). */
  policyBlocked: number;
  identity: Identity;
  /** Distinct pages read, and the most-read ones (path, requests). */
  pages: number;
  topPages: Array<{ path: string; requests: number }>;
  /** Requests per day, oldest first, over the window (zero-filled). */
  daily: number[];
  lastSeen: string | null;
}

export interface AiVisibility {
  sinceIso: string;
  days: number;
  byPurpose: Record<AgentPurpose | "other", number>;
  agents: AiAgentVisibility[];
}

export type VisibilityScope = { tenantId: string } | { site: string };
export type VisibilityQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: VisibilityQuery = async <T,>(sql: string, params?: unknown[]) => (await safeQuery<T>(sql, params ?? [])).rows;

/** One row per (agent, identity, flagged, path, day). */
export function visibilitySql(scope: VisibilityScope): string {
  const where = "tenantId" in scope ? "forcefield_tenant_id = $1" : "forcefield_tenant_id IS NULL AND props->>'site' = $1";
  return `
SELECT props->>'agent' AS agent,
       COALESCE(NULLIF(props->>'agent_verification', ''), CASE WHEN props->>'signature_verification' = 'verified' THEN 'verified' ELSE '' END) AS verification,
       (event_type = 'site.agent_flagged') AS flagged,
       (COALESCE(props->>'reason_kind', '') = 'agent_policy' AND COALESCE(props->>'blocked', '') = 'true') AS policy_blocked,
       COALESCE(path, '/') AS path,
       to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       sum(${EVENT_WEIGHT_SQL})::int AS n,
       max(created_at)::text AS last_seen
  FROM site_analytics_events
 WHERE ${where}
   AND created_at >= $2::timestamptz
   AND event_type IN ('site.agent_welcomed', 'site.agent_flagged')
   AND COALESCE(props->>'agent', 'unidentified') NOT IN ('unidentified', 'signed_agent', '')
   AND COALESCE(props->>'synthetic', '') <> 'true'
 GROUP BY 1, 2, 3, 4, 5, 6`;
}

export interface VisibilityRow {
  agent: string;
  verification: string | null;
  flagged: boolean;
  policy_blocked?: boolean;
  path: string;
  day: string;
  n: number | string;
  last_seen: string | null;
}

const ALL_PURPOSES: Array<AgentPurpose | "other"> = ["ai_training", "ai_search", "ai_assistant", "search_engine", "other"];

/** Fold the grouped rows into the report (pure; exported for tests). A flagged row
 *  for a known agent is an impersonation (a flagged row that is not one is ignored:
 *  the engine names an agent on a flagged event only when it was claimed). */
export function foldVisibility(rows: VisibilityRow[], sinceIso: string, days: number): AiVisibility {
  const dayKeys: string[] = [];
  const start = Date.parse(sinceIso);
  for (let i = 0; i < days; i++) dayKeys.push(new Date(start + i * 86400_000).toISOString().slice(0, 10));
  const index = new Map(dayKeys.map((d, i) => [d, i]));
  const by = new Map<string, { requests: number; impersonations: number; verified: number; policyBlocked: number; paths: Map<string, number>; daily: number[]; last: string | null }>();
  for (const r of rows) {
    const n = Math.max(0, Number(r.n) || 0);
    const a = by.get(r.agent) ?? { requests: 0, impersonations: 0, verified: 0, policyBlocked: 0, paths: new Map(), daily: dayKeys.map(() => 0), last: null };
    if (r.flagged) {
      if (r.verification === "impersonation") a.impersonations += n;
      else { by.set(r.agent, a); continue; }
    } else {
      a.requests += n;
      if (r.policy_blocked) a.policyBlocked += n;
      if (r.verification === "verified") a.verified += n;
      a.paths.set(r.path, (a.paths.get(r.path) ?? 0) + n);
      const i = index.get(r.day);
      if (i !== undefined) a.daily[i] += n;
    }
    if (r.last_seen && (!a.last || r.last_seen > a.last)) a.last = r.last_seen;
    by.set(r.agent, a);
  }
  const agents: AiAgentVisibility[] = [...by.entries()]
    .filter(([, a]) => a.requests > 0 || a.impersonations > 0)
    .map(([agent, a]) => {
      const known = AGENT_PURPOSE[agent];
      return {
        agent,
        vendor: known?.vendor ?? null,
        purpose: known?.purpose ?? "other",
        requests: a.requests,
        verifiedRequests: a.verified,
        impersonations: a.impersonations,
        policyBlocked: a.policyBlocked,
        identity: a.verified > 0 ? "verified" : a.impersonations > 0 && a.requests === 0 ? "impersonation" : "unverified",
        pages: a.paths.size,
        topPages: [...a.paths.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 5).map(([path, requests]) => ({ path, requests })),
        daily: a.daily,
        lastSeen: a.last,
      } satisfies AiAgentVisibility;
    })
    .sort((x, y) => y.requests - x.requests || y.impersonations - x.impersonations || x.agent.localeCompare(y.agent));
  const byPurpose = Object.fromEntries(ALL_PURPOSES.map((p) => [p, agents.filter((a) => a.purpose === p).reduce((s, a) => s + a.requests, 0)])) as AiVisibility["byPurpose"];
  return { sinceIso, days, byPurpose, agents };
}

/** One site's AI visibility over the last `days` (default 30). Never throws. */
export async function getAiVisibility(scope: VisibilityScope, opts: { days?: number; q?: VisibilityQuery; nowMs?: number } = {}): Promise<AiVisibility> {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? 30)));
  const now = opts.nowMs ?? Date.now();
  const sinceIso = new Date(Math.floor(now / 86400_000) * 86400_000 - (days - 1) * 86400_000).toISOString();
  const empty = foldVisibility([], sinceIso, days);
  const key = "tenantId" in scope ? scope.tenantId : scope.site;
  if (!key) return empty;
  try {
    const rows = await (opts.q ?? liveQuery)<VisibilityRow>(visibilitySql(scope), [key, sinceIso]);
    return foldVisibility(rows, sinceIso, days);
  } catch {
    return empty;
  }
}
