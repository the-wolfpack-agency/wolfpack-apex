/**
 * Which integrations have actually run in production, versus merely been built.
 *
 * MOVED HERE FROM scripts/ on 2026-08-26 so /playbook can report the number
 * instead of asserting a count somebody typed. Eighteen integrations are
 * built; twelve have ever run. A client-facing document that says "eighteen
 * integrations" is not wrong about the code and is wrong about the product,
 * and the only way that stays true is if the page reads the same source the
 * script does.
 *
 * `npm run integrations:evidence` prints this; the playbook readiness section
 * renders it. One definition, two readers.
 */
import { query } from "@/lib/db";

type QueryFn = <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
const db = (): QueryFn => query as unknown as QueryFn;

export interface Surface {
  /** The module in src/lib/integrations, without the .ts. */
  module: string;
  /** What a person would call it. */
  label: string;
  /**
   * SQL ILIKE patterns matching the analytics events this surface emits.
   *
   * Patterns rather than a prefix because the event namespaces grew
   * independently of the module names: Teams chat writes `ms_chats.*`, the
   * calendar writes both `calendar.*` and `meeting.*`. Guessing a convention
   * that does not exist would report working surfaces as dead.
   */
  patterns: string[];
}

export const SURFACES: Surface[] = [
  { module: "microsoft-mail", label: "Mail", patterns: ["%mail%", "microsoft.email%"] },
  { module: "microsoft-calendar", label: "Calendar", patterns: ["calendar%", "%calendar%"] },
  { module: "microsoft-online-meetings", label: "Online meetings", patterns: ["meeting%", "%meeting%"] },
  { module: "microsoft-teams-chat", label: "Teams chat", patterns: ["ms_chats%"] },
  { module: "microsoft-channel-messages", label: "Teams channels", patterns: ["ms_teams%"] },
  { module: "microsoft-sharepoint", label: "SharePoint", patterns: ["%sharepoint%"] },
  { module: "microsoft-search-keywords", label: "Search", patterns: ["%search%"] },
  { module: "microsoft-directory", label: "Directory", patterns: ["%directory%"] },
  { module: "microsoft-tasks", label: "Tasks", patterns: ["task%", "%task%"] },
  { module: "microsoft-planner", label: "Planner", patterns: ["%planner%"] },
  { module: "microsoft-groups", label: "Groups", patterns: ["%group%"] },
  { module: "microsoft-files", label: "Files", patterns: ["%file%"] },
  { module: "microsoft-people", label: "People", patterns: ["%people%"] },
  { module: "microsoft-contacts", label: "Contacts", patterns: ["%contact%"] },
  { module: "microsoft-mailbox", label: "Mailbox settings", patterns: ["%mailbox%"] },
  { module: "microsoft-onenote", label: "OneNote", patterns: ["%onenote%"] },
  { module: "microsoft-presence", label: "Presence", patterns: ["%presence%"] },
  { module: "microsoft-project", label: "Project", patterns: ["%project%"] },
];

export interface Evidence {
  label: string;
  module: string;
  events: number;
  lastSeen: string | null;
  /** Days since the last event, or null when there has never been one. */
  ageDays: number | null;
}

/** ACTIVE, STALE and UNPROVEN, and the boundary is a judgment worth naming. */
export function verdict(e: Evidence): "active" | "stale" | "unproven" {
  if (e.events === 0 || e.ageDays === null) return "unproven";
  /* A fortnight. Long enough to survive a quiet week, short enough that
     "it worked in June" does not read as working. */
  return e.ageDays <= 14 ? "active" : "stale";
}

/** SQL LIKE semantics, applied in memory. Only `%` is used by SURFACES. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/%/g, ".*")}$`, "i");
}

export async function gatherEvidence(days = 90): Promise<Evidence[]> {
  const query = db();

  /* GROUP FIRST, MATCH SECOND.
   *
   * This began as a query per surface inside a for-loop: twenty-one sequential
   * round trips. Collapsing them into one query with twenty-one FILTER clauses
   * removed the round trips and was still nine seconds, because the cost was
   * never the round trips. instinct_events holds 1.9 MILLION rows over ninety
   * days, and each surface carries two or three ILIKE patterns, so the single
   * query evaluated roughly sixty pattern comparisons against every one of
   * those rows.
   *
   * There are 343 DISTINCT event types. Aggregating by event_type first turns
   * the same answer into one grouped scan plus pattern matching over a few
   * hundred strings in memory.
   *
   * The reason this mattered: /playbook renders these figures on every request,
   * so nine seconds of query time became a nine-second navigation, against a
   * tenth of a second for every other page. The nav gives no feedback while it
   * waits, so it was reported as a button that does nothing, which is exactly
   * what it looked like. Latency invisible in a script is a defect the moment
   * a page awaits it. */
  const { rows } = await query<{ event_type: string; n: string; last: string | null }>(
    `SELECT event_type,
            count(*)::text AS n,
            max(timestamp)::date::text AS last
       FROM instinct_events
      WHERE timestamp > NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY event_type`,
    [days],
  );

  const now = Date.now();
  const out: Evidence[] = SURFACES.map((s) => {
    const res = s.patterns.map(likeToRegExp);
    let events = 0;
    let last: string | null = null;
    for (const r of rows) {
      if (!res.some((re) => re.test(r.event_type))) continue;
      events += Number(r.n);
      /* Most recent across every event type this surface matches. */
      if (r.last && (last === null || r.last > last)) last = r.last;
    }
    const ageDays = last === null ? null : Math.floor((now - Date.parse(last)) / 86_400_000);
    return {
      label: s.label,
      module: s.module,
      events,
      lastSeen: last,
      ageDays: ageDays === null || Number.isNaN(ageDays) ? null : ageDays,
    };
  });

  return out.sort((a, b) => b.events - a.events);
}

