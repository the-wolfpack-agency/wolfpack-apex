/**
 * Readiness report runner - grades every tool in the readiness catalog against
 * the REAL repo and prints an honest board (ready / partial / gap per criterion).
 *
 *   npm run readiness:report            # print the board for every tool
 *   npm run readiness:report forcefield # one tool
 *   npm run readiness:report -- --json  # machine-readable (for CI / a dashboard)
 *
 * This is the "execute the self-audit ourselves" surface: the same engine the
 * catalog tests exercise, pointed at the live tree, so the score is a current
 * fact, not a doc that rots. Non-zero exit is never forced here - it reports.
 */
import { READINESS_TOOLS, toolById } from "../src/lib/readiness/catalog";
import { reportTool, scorePct } from "../src/lib/readiness/report";
import { createFsRepoReader } from "../src/lib/readiness/fs-reader";

const args = process.argv.slice(2);
const json = args.includes("--json");
const only = args.find((a) => !a.startsWith("--"));

const reader = createFsRepoReader(process.cwd());
const specs = only ? [toolById(only)].filter(Boolean) : [...READINESS_TOOLS];
if (only && specs.length === 0) {
  console.error(`Unknown tool "${only}". Known: ${READINESS_TOOLS.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

const reports = specs.map((spec) => reportTool(spec!, reader));

if (json) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  const icon = (s: string) => (s === "ready" ? "✓" : s === "partial" ? "~" : "✗");
  for (const r of reports) {
    console.log(`\n${r.label}  (${r.surface})`);
    console.log(`  ${scorePct(r.score)}%  -  ${r.ready} ready / ${r.partial} partial / ${r.gap} gap`);
    for (const c of r.results) {
      console.log(`    ${icon(c.status)} [${c.status.padEnd(7)}] ${c.title}`);
      console.log(`         ${c.evidence}`);
    }
  }
  const overall = reports.reduce((n, r) => n + r.score, 0) / (reports.length || 1);
  console.log(`\nOverall across ${reports.length} tool(s): ${scorePct(overall)}%`);
}
