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

/** ACTIVE, STALE and UNPROVEN, and the boundary is a judgement worth naming. */
export function verdict(e: Evidence): "active" | "stale" | "unproven" {
  if (e.events === 0 || e.ageDays === null) return "unproven";
  /* A fortnight. Long enough to survive a quiet week, short enough that
     "it worked in June" does not read as working. */
  return e.ageDays <= 14 ? "active" : "stale";
}

export async function gatherEvidence(days = 90): Promise<Evidence[]> {
  const query = db();
  const out: Evidence[] = [];
  for (const s of SURFACES) {
    const clauses = s.patterns.map((_, i) => `event_type ILIKE $${i + 2}`).join(" OR ");
    const { rows } = await query<{ n: string; last: string | null; age: string | null }>(
      `SELECT count(*)::text AS n,
              max(timestamp)::date::text AS last,
              EXTRACT(DAY FROM NOW() - max(timestamp))::text AS age
         FROM instinct_events
        WHERE timestamp > NOW() - ($1::int * INTERVAL '1 day')
          AND (${clauses})`,
      [days, ...s.patterns],
    );
    const r = rows[0];
    out.push({
      label: s.label,
      module: s.module,
      events: Number(r?.n ?? 0),
      lastSeen: r?.last ?? null,
      ageDays: r?.age === null || r?.age === undefined ? null : Math.floor(Number(r.age)),
    });
  }
  return out.sort((a, b) => b.events - a.events);
}

