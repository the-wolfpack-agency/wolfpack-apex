/**
 * Which learning capabilities have data, and which are starved.
 *
 * Eleven signal extractors have no caller, which reads as somebody forgetting
 * to wire them up. Their source tables are empty: the Microsoft sync has never
 * run for mail, calendar, contacts, files, Teams or OneNote, while the product
 * calls Graph live on every request and keeps nothing.
 *
 * An unwired extractor is an afternoon of plumbing. A starved one is a
 * decision about what to cache, how long to keep it and who may read it.
 *
 *   npm run insights:learning-inputs
 */
import "./load-env";

import { query } from "@/lib/db";
import {
  LEARNING_INPUTS,
  readInput,
  assessLearningInputs,
  describeLearningReadiness,
} from "@/lib/insights/learning-inputs";

async function rowsIn(table: string): Promise<number | null> {
  /* Existence first, so an absent table is reported as absent rather than as
     an error that says nothing about which of the two faults it is. */
  const exists = await query<{ ok: string | null }>(
    `SELECT to_regclass($1)::text AS ok`,
    [`public.${table}`],
  );
  if (!exists.rows[0]?.ok) return null;
  const n = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(n.rows[0].n);
}

async function main() {
  const readings = [];
  for (const input of LEARNING_INPUTS) {
    const counts = [];
    for (const table of input.sources) counts.push({ table, rows: await rowsIn(table) });
    readings.push(readInput(input, counts));
  }

  const readiness = assessLearningInputs(readings);
  console.log("Learning inputs\n");
  console.log(describeLearningReadiness(readiness));

  console.log(`\nSource tables:`);
  for (const r of readings) {
    const mark =
      r.state === "fed" ? "ok  " : r.state === "thin" ? "thin" : r.state === "starved" ? "none" : "GONE";
    const detail = r.counts
      .map((c) => `${c.table}=${c.rows === null ? "absent" : c.rows}`)
      .join("  ");
    console.log(`  ${mark}  ${r.input.extractor.padEnd(28)} ${detail}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
