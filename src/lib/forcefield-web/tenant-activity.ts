/**
 * Who visited ONE tenant's site: the agents and bots Forcefield saw, what each
 * did, and how Forcefield handled it. Feeds the client dashboard
 * (/api/forcefield/my-stats) and the "first hour" email (tenant-alerts.ts).
 *
 * An agent is grouped by the name the engine gave it (a known crawler, a named
 * tool), else by its stable operator fingerprint (props.fp). Only automation is
 * listed (site.agent_* events); human page views are not. Synthetic monitor
 * traffic (props.synthetic, our own probes) is excluded.
 *
 * Handling, most decisive first:
 *   blocked   the request was turned away (props.blocked),
 *   slowed    its session was tarpitted (an applied intent step-up),
 *   welcomed  a known-good agent given the welcome lane,
 *   caught    proven hostile but watch mode or the plan withheld the block,
 *   watched   recorded and reported only.
 *
 * Counts only, tenant-scoped (every query is constrained to forcefield_tenant_id),
 * no IP, no visitor identity. Injectable query; never throws (degrades to empty).
 */
import { safeQuery } from "@/lib/db";

export type Handling = "blocked" | "slowed" | "welcomed" | "caught" | "watched";

export interface AgentActivity {
  /** Display name: the agent or tool name, else "Unnamed <kind>". */
  name: string;
  /** Client class from the engine (fingerprint.ts ClientType). */
  kind: string;
  requests: number;
  /** What it did, in plain words (the most severe thing it tried). */
  did: string;
  handled: Handling;
  lastSeen: string | null;
}

export interface TenantActivity {
  sinceIso: string;
  counts: { agentsSeen: number; welcomed: number; slowed: number; blocked: number; caught: number };
  /** The most active agents first. */
  agents: AgentActivity[];
}

export type ActivityQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: ActivityQuery = async <T,>(sql: string, params?: unknown[]) => (await safeQuery<T>(sql, params ?? [])).rows;

export const ACTIVITY_SQL = `
WITH ev AS (
  SELECT coalesce(nullif(props->>'agent', 'unidentified'), nullif(props->>'tool', ''), 'unnamed:' || coalesce(props->>'fp', props->>'sig', '?')) AS who,
         props->>'client_type' AS client_type,
         props->>'fp' AS fp,
         props->>'attack' AS attack,
         props->>'probe' AS probe,
         event_type,
         created_at,
         coalesce(props->>'blocked', '') = 'true' AS blocked,
         coalesce(props->>'would_block', '') = 'true' AS would_block
    FROM site_analytics_events
   WHERE forcefield_tenant_id = $1
     AND created_at >= $2::timestamptz
     AND event_type LIKE 'site.agent_%'
     AND COALESCE(props->>'synthetic', '') <> 'true'
), slowed AS (
  SELECT DISTINCT props->>'fp' AS fp
    FROM site_analytics_events
   WHERE forcefield_tenant_id = $1
     AND created_at >= $2::timestamptz
     AND event_type = 'site.intent_scored'
     AND props->>'intent_action' = 'tarpit'
     AND coalesce(props->>'intent_applied', '') = 'true'
     AND COALESCE(props->>'synthetic', '') <> 'true'
)
SELECT who,
       max(client_type) AS client_type,
       count(*)::int AS requests,
       max(created_at)::text AS last_seen,
       bool_or(blocked) AS blocked,
       bool_or(would_block) AS would_block,
       bool_or(fp IN (SELECT fp FROM slowed)) AS slowed,
       bool_or(event_type = 'site.agent_welcomed') AS welcomed,
       bool_or(event_type = 'site.agent_trap_tripped') AS trapped,
       bool_or(event_type = 'site.agent_payload_attack') AS payload,
       bool_or(event_type = 'site.agent_probed_sensitive') AS probed,
       bool_or(event_type = 'site.agent_high_rate') AS high_rate,
       max(attack) AS attack,
       max(probe) AS probe
  FROM ev
 GROUP BY who
 ORDER BY count(*) DESC, max(created_at) DESC
 LIMIT 500`;

export interface ActivityRow {
  who: string;
  client_type: string | null;
  requests: number | string;
  last_seen: string | null;
  blocked: boolean;
  would_block: boolean;
  slowed: boolean;
  welcomed: boolean;
  trapped: boolean;
  payload: boolean;
  probed: boolean;
  high_rate: boolean;
  attack: string | null;
  probe: string | null;
}

const KIND_LABEL: Record<string, string> = {
  known_crawler: "crawler",
  scanner: "scanner",
  scripted_library: "script",
  headless: "headless browser",
  browser: "browser-like bot",
  unknown: "bot",
};
const words = (s: string) => s.replace(/_/g, " ");

/** Map one grouped row to the client-facing shape. Pure; exported for tests. */
export function agentFromRow(r: ActivityRow): AgentActivity {
  const kind = r.client_type || "automation";
  const unnamed = r.who.startsWith("unnamed:");
  const name = unnamed ? `Unnamed ${KIND_LABEL[kind] ?? words(kind)} (${r.who.slice(8, 14)})` : r.who;
  const hostile = r.trapped || r.payload || r.probed || r.blocked || r.would_block;
  const did = r.trapped
    ? "Tripped a hidden decoy only a scanner would find"
    : r.payload
      ? `Sent an attack payload${r.attack ? ` (${words(r.attack)})` : ""}`
      : r.probed
        ? `Probed a sensitive path${r.probe ? ` (${words(r.probe)})` : ""}`
        : r.welcomed
          ? "Read your public pages"
          : r.high_rate
            ? "Made requests faster than a person can"
            : "Visited as automation";
  const handled: Handling = r.blocked ? "blocked" : r.slowed ? "slowed" : r.welcomed && !hostile ? "welcomed" : r.would_block || hostile ? "caught" : "watched";
  return { name, kind, requests: Math.max(0, Number(r.requests) || 0), did, handled, lastSeen: r.last_seen };
}

/** One tenant's agent activity since `sinceIso`. Never throws. */
export async function getTenantActivity(tenantId: string, sinceIso: string, opts: { limit?: number; q?: ActivityQuery } = {}): Promise<TenantActivity> {
  const empty: TenantActivity = { sinceIso, counts: { agentsSeen: 0, welcomed: 0, slowed: 0, blocked: 0, caught: 0 }, agents: [] };
  if (!tenantId) return empty;
  try {
    const rows = await (opts.q ?? liveQuery)<ActivityRow>(ACTIVITY_SQL, [tenantId, sinceIso]);
    const all = rows.map(agentFromRow);
    const count = (h: Handling) => all.filter((a) => a.handled === h).length;
    return {
      sinceIso,
      counts: { agentsSeen: all.length, welcomed: count("welcomed"), slowed: count("slowed"), blocked: count("blocked"), caught: count("caught") },
      agents: all.slice(0, opts.limit ?? 25),
    };
  } catch {
    return empty;
  }
}
