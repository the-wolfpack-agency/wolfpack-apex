/**
 * Per-site AI agent policy: which AI TRAINING crawlers a site turns away.
 *
 * Training is the use site owners most often opt out of, and blocking it does not
 * change how a site appears in search or in AI answers (those come from other
 * agents: OAI-SearchBot, Claude-SearchBot, assistants acting for a person), so
 * only agents whose documented purpose is "ai_training" (ai-visibility.ts
 * AGENT_PURPOSE) can be blocked here. Default: everything allowed.
 *
 * Scope: "tenant:<uuid>" for a client, "site:<label>" for our own properties.
 * Enforcement is the engine's (enforce.ts, reasonKind "agent_policy"), under the
 * same watch-mode and license gates as every other block. Reads fail OPEN (an
 * unreadable policy blocks nothing); writes report failure.
 */
import { query, safeQuery } from "@/lib/db";
import { AGENT_PURPOSE } from "@/lib/forcefield-web/ai-visibility";

/** The agents a site may block: documented AI training crawlers, stable order. */
export const AI_TRAINING_AGENTS: readonly string[] = Object.entries(AGENT_PURPOSE)
  .filter(([, v]) => v.purpose === "ai_training")
  .map(([id]) => id)
  .sort();

export type PolicyScope = `tenant:${string}` | `site:${string}`;
export const tenantScope = (tenantId: string): PolicyScope => `tenant:${tenantId}`;
export const siteScope = (label: string): PolicyScope => `site:${label}`;
const SCOPE_RE = /^(tenant:[0-9a-f-]{36}|site:[a-z0-9._-]{1,64})$/;

/** The query function the policy runs on (the app's db, or a test's pg client). */
export type PolicyQuery = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const appRead: PolicyQuery = (text, params) => safeQuery(text, params) as never;
const appWrite: PolicyQuery = (text, params) => query(text, params) as never;

export interface AgentPolicy {
  blockedAgents: string[];
  updatedAt: string | null;
}

/** Validate a requested block list (pure): only AI training agents, no repeats. */
export function validateBlockedAgents(v: unknown): { ok: true; agents: string[] } | { ok: false; error: "invalid_request" | "not_a_training_agent" } {
  if (!Array.isArray(v) || v.length > AI_TRAINING_AGENTS.length || v.some((a) => typeof a !== "string")) return { ok: false, error: "invalid_request" };
  const agents = [...new Set(v as string[])];
  if (agents.some((a) => !AI_TRAINING_AGENTS.includes(a))) return { ok: false, error: "not_a_training_agent" };
  return { ok: true, agents: agents.sort() };
}

/** The policy for a scope; an unreadable or missing policy blocks nothing. */
export async function getAgentPolicy(scope: PolicyScope, q: PolicyQuery = appRead): Promise<AgentPolicy> {
  const none: AgentPolicy = { blockedAgents: [], updatedAt: null };
  if (!SCOPE_RE.test(scope)) return none;
  try {
    const { rows } = await q("SELECT blocked_agents, updated_at::text AS updated_at FROM forcefield_agent_policies WHERE scope = $1", [scope]);
    const r = rows[0] as { blocked_agents: string[]; updated_at: string } | undefined;
    if (!r) return none;
    // Only agents still on the training list are ever served (a list change can never widen a block).
    return { blockedAgents: (r.blocked_agents ?? []).filter((a) => AI_TRAINING_AGENTS.includes(a)), updatedAt: r.updated_at };
  } catch {
    return none;
  }
}

/** Replace a scope's block list. Returns the previous list for the audit trail. */
export async function setAgentPolicy(scope: PolicyScope, agents: string[], updatedBy: string, q: PolicyQuery = appWrite): Promise<{ ok: true; previous: string[] } | { ok: false }> {
  if (!SCOPE_RE.test(scope)) return { ok: false };
  try {
    const before = await getAgentPolicy(scope, q);
    await q(
      `INSERT INTO forcefield_agent_policies (scope, blocked_agents, updated_by, updated_at)
       VALUES ($1, $2::text[], $3, now())
       ON CONFLICT (scope) DO UPDATE SET blocked_agents = EXCLUDED.blocked_agents, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [scope, agents, updatedBy.slice(0, 120)],
    );
    return { ok: true, previous: before.blockedAgents };
  } catch {
    return { ok: false };
  }
}
