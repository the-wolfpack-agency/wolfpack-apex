/**
 * Which integrations are BUILT, and which have ever actually worked.
 *
 * Eighteen Microsoft Graph surfaces exist in this repo. Before a client call
 * that is a tempting number to say out loud, and it is the wrong number: built
 * and proven are different claims, and only one of them survives a client
 * asking "can you show me".
 *
 * Measured on 2026-08-26 over ninety days of production: mail, meetings,
 * SharePoint and search active that day; Teams and calendar within the week;
 * directory, tasks, planner and groups real but stale; and files, people,
 * contacts, mailbox, OneNote, presence and project with no production
 * evidence at all. Seven of eighteen had never been exercised.
 *
 * THIS IS A REPORT, NOT A GATE. An unused surface is not a defect: nobody has
 * needed it yet. It becomes a defect the moment somebody counts it in a
 * promise, so the point is that the count is available before the promise
 * rather than after it.
 *
 *   npx tsx scripts/integration-evidence.ts
 *   npx tsx scripts/integration-evidence.ts --days 30
 *
 * The surface list is asserted against the files on disk by
 * src/lib/integrations/__tests__/integration-evidence.test.ts, so a new
 * integration cannot be silently missing from this inventory.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

/* DYNAMIC IMPORT, and it is not a style choice. A static `import` is hoisted
   above config() above, so src/lib/db would read DATABASE_URL before dotenv
   had set it, build its pool without a connection string, and fail with a TLS
   error that points at everything except the real cause. scripts/brain-eval.ts
   already does this for the same reason. */
type QueryFn = <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

async function db(): Promise<QueryFn> {
  const m = await import("../src/lib/db");
  return m.query as unknown as QueryFn;
}

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
  const query = await db();
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

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i >= 0 ? Number(process.argv[i + 1]) : 90;
  const rows = await gatherEvidence(days);

  console.log(`\nIntegration evidence, last ${days} days\n`);
  console.log("  surface              verdict     events  last seen");
  console.log("  " + "-".repeat(56));
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(20)} ${verdict(r).padEnd(11)} ${String(r.events).padStart(6)}  ${r.lastSeen ?? "never"}`,
    );
  }

  const counts = { active: 0, stale: 0, unproven: 0 };
  for (const r of rows) counts[verdict(r)]++;
  console.log(
    `\n  ${SURFACES.length} built. ${counts.active} active, ${counts.stale} stale, ${counts.unproven} never exercised.`,
  );
  /* The sentence this script exists to make available before a client call
     rather than during one. */
  console.log(`  Say "${counts.active + counts.stale} have run in production", not "${SURFACES.length} integrations".\n`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[integration-evidence]", (err as Error).message);
      process.exit(1);
    },
  );
}
