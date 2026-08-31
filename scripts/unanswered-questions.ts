/**
 * What this organisation asked that nothing connected could answer.
 *
 * Needs both halves and almost nobody has both: the questions people actually
 * asked, and the estate that failed them. A content audit says what a client
 * has; this says what they needed and did not have, ranked by how often
 * somebody wanted it.
 *
 *   npm run insights:unanswered
 *   npm run insights:unanswered -- --days 90
 */
import "./load-env";

import { query } from "@/lib/db";
import {
  buildGapReport,
  describeGapReport,
  type AskedQuestion,
  type GapSystem,
} from "@/lib/insights/unanswered";
import { connectedSystems } from "@/lib/assistant/tools/capability-scope";
import { isServiceIdentity, describeTraffic, splitTraffic } from "@/lib/insights/traffic";

/**
 * Which systems could have answered anything at all.
 *
 * Documents are connected when there is a corpus. The rest come from the same
 * connector state the capability menu reads, so the report and the product
 * never disagree about what is linked.
 */
async function connected(): Promise<Set<GapSystem>> {
  const systems = new Set<GapSystem>();
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM brain_documents WHERE status = 'indexed'`,
  );
  if (Number(rows[0]?.n ?? 0) > 0) systems.add("documents");

  const linked = await connectedSystems("default");
  if (linked.has("crm")) systems.add("crm");
  if (linked.has("dms")) systems.add("dealer-system");
  if (linked.has("quickbooks")) systems.add("finance");

  /* Microsoft is connected when somebody has a token, which is what makes
     calendar and mail answerable. Meeting CONTENT is deliberately not implied
     by that: a calendar entry is not a transcript, and treating them as one
     source is what would file "what did we discuss" under a system that
     cannot answer it. */
  const ms = await query<{ n: string }>(`SELECT count(*)::text AS n FROM instinct_ms_tokens`);
  if (Number(ms.rows[0]?.n ?? 0) > 0) {
    systems.add("calendar");
    systems.add("mail");
  }
  return systems;
}

/* The same rule as isServiceIdentity, expressed once for the database so the
   grouping happens on people's rows rather than being filtered afterwards.
   Kept beside its TypeScript twin because two copies that drift would report
   different numbers from the same log. */
const SERVICE_SQL = `user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     AND user_id NOT LIKE '%@%'`;

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i > -1 ? Number(process.argv[i + 1]) || 30 : 30;

  /* Misses AND hits for the same question, so a gap that has since closed can
     be told from one still open. Asking only for misses reports a question as
     missing forever, however many times it has been answered since. */
  /* PEOPLE ONLY. Half this log is our own eval harness, transcript probe and
     demo user, and a gap report ranked by our testing tells a client what WE
     happened to try rather than what THEY needed. Split before grouping, so
     the counts are of people asking. */
  const raw = await query<{ user_id: string }>(
    `SELECT user_id FROM brain_query_log
      WHERE created_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const split = splitTraffic(raw.rows, (r) => r.user_id);

  const { rows } = await query<{ query: string; misses: string; hits: string; last: string }>(
    `SELECT lower(trim(query)) AS query,
            count(*) FILTER (WHERE hit_count = 0)::text AS misses,
            count(*) FILTER (WHERE hit_count > 0)::text AS hits,
            max(created_at) FILTER (WHERE hit_count = 0)::date::text AS last
       FROM brain_query_log
      WHERE created_at > now() - ($1 || ' days')::interval
        AND length(trim(query)) > 8
        AND NOT (${SERVICE_SQL})
      GROUP BY lower(trim(query))
     HAVING count(*) FILTER (WHERE hit_count = 0) > 0
      ORDER BY count(*) FILTER (WHERE hit_count = 0) DESC
      LIMIT 200`,
    [String(days)],
  );

  const asked: AskedQuestion[] = rows.map((r) => ({
    query: r.query,
    asked: Number(r.misses),
    lastAsked: r.last,
    sinceAnswered: Number(r.hits) > 0,
  }));

  const linked = await connected();
  const report = buildGapReport(asked, linked);

  console.log(`Unanswered questions, last ${days} days`);
  console.log(`Connected: ${[...linked].sort().join(", ") || "nothing"}`);
  const traffic = describeTraffic(split);
  if (traffic) console.log(traffic);
  console.log("");
  console.log(describeGapReport(report));

  if (report.wouldBeAnsweredByConnecting.length > 0) {
    console.log(`\nWould be answered by connecting a system:`);
    for (const g of report.wouldBeAnsweredByConnecting.slice(0, 10)) {
      console.log(`  ${String(g.asked).padStart(3)}x  ${g.system.padEnd(14)} ${g.query.slice(0, 62)}`);
    }
  }
  if (report.closedSince.length > 0) {
    console.log(`\nWent unanswered then, answered now:`);
    for (const g of report.closedSince.slice(0, 6)) {
      console.log(`  ${String(g.asked).padStart(3)}x  ${g.query.slice(0, 70)}`);
    }
  }
  if (report.askedUsToDoSomething.length > 0) {
    console.log(`\nAsked the product to do something it does not do:`);
    for (const g of report.askedUsToDoSomething.slice(0, 8)) {
      console.log(`  ${String(g.asked).padStart(3)}x  ${g.query.slice(0, 70)}`);
    }
  }
  if (report.genuinelyMissing.length > 0) {
    console.log(`\nAsked of a connected system, and still not there:`);
    for (const g of report.genuinelyMissing.slice(0, 10)) {
      console.log(`  ${String(g.asked).padStart(3)}x  ${g.system.padEnd(14)} ${g.query.slice(0, 62)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
