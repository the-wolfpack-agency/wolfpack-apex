/**
 * Does a client's decision history carry signal? Ask before building a pipe.
 *
 * THE STEP BEFORE A CONNECTOR. A change-request export answers whether their
 * decisions predict anything, and it costs nobody a consent grant, an API key
 * or an afternoon of integration work. If the answer is no, we learned it for
 * the price of a CSV; if yes, the connector has an argument behind it.
 *
 * Same discipline as the gist experiment on our own data, which is what said
 * the shape was worth storing in the first place.
 *
 *   npx tsx scripts/gist-from-export.ts <export.csv>
 *   npx tsx scripts/gist-from-export.ts <export.csv> --status "Workflow Stage"
 *
 * READS A FILE AND PRINTS NUMBERS. It stores nothing, sends nothing, and never
 * prints a description, a title or a person's name: the analysis works on
 * category, decider, latency band and ending, all closed vocabularies.
 */

export {};

import { readFileSync } from "node:fs";
import { parseCsv } from "@/lib/gist/csv";
import { detectColumns, readChangeRequests, type ColumnRole } from "@/lib/gist/from-change-request";
import { measureSignal, MIN_OBSERVATIONS } from "@/lib/gist/signal";
import type { DecisionGist } from "@/lib/gist/decision";

/* Named as a reader of a change-request report would name them. measureSignal
   is generic over its features precisely so this does not have to pretend a
   decision is an assistant turn. */
const DECISION_FEATURES = [
  { name: "requestType", of: (d: DecisionGist) => d.category },
  { name: "decidedBy", of: (d: DecisionGist) => d.decider },
  { name: "timeToDecide", of: (d: DecisionGist) => d.latency },
  /* ending IS NOT A FEATURE, for the same reason admittedMiss is not one in
     the assistant run: wentWell is DERIVED from the ending, so predicting
     badness from it is the label predicting itself. It scored a lift on the
     first run of this script and looked like a finding.
     See EXCLUDED_AS_CIRCULAR in lib/gist/signal.ts. A field that participates
     in the outcome belongs in the outcome, never in the predictors. */
];

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/gist-from-export.ts <export.csv> [--status <column>]");
  process.exit(2);
}

const override = (role: ColumnRole): string | null => {
  const i = process.argv.indexOf(`--${role}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const table = parseCsv(readFileSync(file, "utf8"));
if (table.rows.length === 0) {
  console.error("No rows found. Is this a CSV export?");
  process.exit(1);
}

const detected = detectColumns(table.headers);
for (const role of ["status", "created", "decided", "category"] as ColumnRole[]) {
  const forced = override(role);
  if (forced) detected[role] = forced;
}

console.log(`\n${table.rows.length} rows, ${table.headers.length} columns\n`);
console.log("Columns this will use (override with --status, --created, --decided, --category):");
for (const [role, col] of Object.entries(detected)) {
  console.log(`  ${role.padEnd(9)} ${col ?? "NOT FOUND"}`);
}

if (!detected.status) {
  console.error(
    "\nNo status column found, and without one there is no outcome to measure.\n" +
      `Columns available: ${table.headers.join(", ")}\n` +
      "Name it with --status <column>.",
  );
  process.exit(1);
}

const reading = readChangeRequests(table.rows, detected);

console.log(`\n${reading.gists.length} decisions read, ${reading.skipped} rows skipped for having no status.`);

/* THE HONEST PART. A status nobody mapped is a decision nobody can learn
   from, and it must be visible rather than quietly counted as "unknown". */
if (reading.unmapped.length > 0) {
  const total = reading.unmapped.reduce((n, u) => n + u.count, 0);
  console.log(`\n${total} rows carry a status this does not recognise:`);
  for (const u of reading.unmapped.slice(0, 12)) {
    console.log(`  ${String(u.count).padStart(5)}  ${u.status}`);
  }
  console.log(
    "\n  Each of those counts as 'unknown' and cannot support a conclusion.\n" +
      "  Tell me what they mean and they become part of the measurement.",
  );
}

const endings = new Map<string, number>();
for (const g of reading.gists) endings.set(g.ending, (endings.get(g.ending) ?? 0) + 1);
console.log("\nHow these decisions ended:");
for (const [k, v] of [...endings].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(11)} ${String(v).padStart(6)}  ${((v / reading.gists.length) * 100).toFixed(1)}%`);
}

const report = measureSignal(reading.gists, {
  features: DECISION_FEATURES,
  isBad: (d) => !d.wentWell,
});
console.log(`\nBase rate of a decision going badly: ${(report.baseBadRate * 100).toFixed(1)}%`);
console.log(`(reversed, abandoned, pending or unrecognised; a REJECTION counts as going well,`);
console.log(` because a change refused by a reviewer is the process working)\n`);

console.log(`Which shapes predict trouble (floor ${MIN_OBSERVATIONS} observations):`);
for (const s of report.signals) {
  const flag = !s.trustworthy ? "too few" : s.lift >= 1.5 ? "PREDICTS" : s.lift <= 0.5 ? "protects" : "";
  console.log(
    `  ${(s.feature + "=" + s.value).padEnd(28)} n=${String(s.observations).padStart(5)}  bad=${(s.badRate * 100).toFixed(1).padStart(5)}%  lift=${s.lift.toFixed(2).padStart(5)}  ${flag}`,
  );
}

console.log(
  `\n${report.usable.length} shape(s) both clear the floor and move the rate enough to act on.`,
);
console.log(
  report.usable.length > 0
    ? "Their decision history carries signal. A connector has an argument behind it."
    : "No usable signal on this export. A connector would move noise, and that is worth knowing now.",
);
process.exit(0);
