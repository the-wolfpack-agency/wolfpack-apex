/**
 * A query over the analytics table must say which events it wants.
 *
 * WHAT THIS COSTS WHEN IT IS MISSING. The pilot dashboard filtered
 * instinct_events by date alone and counted four event types inside the
 * aggregates. Correct, and it read 2,639,165 rows to produce a figure that
 * needs 6,385 of them, running an identity regex on every one. 1,445ms for
 * four numbers, and the page took twenty seconds to appear.
 *
 * The table is 4,150,425 rows and 57.6 per cent of them are one event:
 * system.token_verified, machine noise from the auth path. August alone added
 * 2.2 million rows, five times the previous monthly rate. So this is not a
 * problem that was fixed; it is a problem that gets worse on a schedule, and
 * the next panel written the same way will be slower than the last one was.
 *
 * NARROWING IS FREE AND CHANGES NO NUMBER. Every aggregate already requires a
 * type. Saying so in the WHERE clause lets Postgres use the index instead of
 * reading the table, which is the whole fix.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not demand a date filter, because
 * a lifetime count is a real thing to want. It only asks that a query which
 * bounds by DATE also bounds by TYPE, since that is the shape that reads
 * millions of rows to report thousands.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src");

/**
 * Queries allowed to read the whole window.
 *
 * Each is here because it genuinely wants every event, and each says why. An
 * allowlist without reasons becomes the place slow queries go to hide.
 */
const READS_EVERY_EVENT: Record<string, string> = {
  "src/lib/analytics.ts": "the writer and its own retention sweep, which is about all events by definition",
  "src/app/api/analytics/route.ts": "the ingest endpoint, which counts what it just wrote",
  "src/app/api/usage/route.ts": "usage is the total, so filtering by type would answer a different question",
  /* The four below all GROUP BY event_type to report which events happened.
     Naming the types would answer a different question, so the mitigation for
     these is the WINDOW rather than the filter. They are listed individually
     rather than as a pattern so that adding a fifth is a decision. */
  "src/lib/assistant.ts": "answers 'what is happening' when somebody asks an analytics question; every type is the point, and it is gated behind isAnalyticsQuestion",
  "src/lib/integrations/evidence.ts": "per-type counts for the integration evidence report; the breakdown IS the output",
  "src/lib/morning-briefing.ts": "excludes two noisy types and wants the rest, over 24 hours, one row per person per type",
  "src/lib/report-templates.ts": "top-ten feature usage. Note the date range defaults to 2026-01-01 when a report omits one, which reads most of the table; worth bounding if these reports get run often",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Each SQL statement over the table, with the line it starts on.
 *
 * The line matters: a file here can hold five queries, and an error naming
 * only the file sends somebody reading all five to find the one. A guardrail
 * that is annoying to act on is a guardrail that gets an allowlist entry
 * instead of a fix.
 */
function statementsOver(source: string): { sql: string; line: number }[] {
  const out: { sql: string; line: number }[] = [];
  const re = /FROM\s+instinct_events/gi;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    /* To the closing backtick of the template literal, which is where a query
       in this codebase ends. Bounded so one statement cannot swallow the
       next. */
    const rest = source.slice(m.index, m.index + 1400);
    const end = rest.indexOf("`");
    out.push({
      sql: end > 0 ? rest.slice(0, end) : rest,
      line: source.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const BOUNDS_BY_DATE = /\b(timestamp|created_at)\s*[><]/i;
const BOUNDS_BY_TYPE = /event_type\s*(=|IN|ANY|~|LIKE)/i;

describe("queries over the analytics table", () => {
  const files = walk(ROOT).filter((f) => fs.readFileSync(f, "utf8").includes("FROM instinct_events"));

  it("name the events they want when they bound by date", () => {
    const wide: string[] = [];

    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      if (rel in READS_EVERY_EVENT) continue;

      for (const { sql, line } of statementsOver(fs.readFileSync(file, "utf8"))) {
        if (!BOUNDS_BY_DATE.test(sql)) continue;
        if (BOUNDS_BY_TYPE.test(sql)) continue;
        wide.push(
          `${rel}:${line} bounds by date but not by event_type, so it reads every ` +
            `event in the window. Name the types, or allowlist it with a reason.`,
        );
      }
    }

    expect(wide.join("\n")).toBe("");
  });

  /* The detector is the whole test, so a change that stopped it matching would
     pass silently and guard nothing. */
  it("can tell a narrow query from a wide one", () => {
    const wide = "FROM instinct_events WHERE timestamp > NOW() - INTERVAL '60 days'";
    const narrow = `${wide} AND event_type IN ('a','b')`;
    expect(BOUNDS_BY_DATE.test(wide) && !BOUNDS_BY_TYPE.test(wide)).toBe(true);
    expect(BOUNDS_BY_TYPE.test(narrow)).toBe(true);
  });

  it("is actually looking at the files that query the table", () => {
    expect(files.length).toBeGreaterThan(15);
  });
});
