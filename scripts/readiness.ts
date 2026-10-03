/**
 * `npm run readiness` - scan this repo and print each tool's production-readiness.
 *
 * Deterministic, dogfoods by construction: it reads our own source tree, grades
 * every tool in the catalog, and prints a board (overall score, per-dimension,
 * and every criterion with its evidence). Flags:
 *   --json            machine-readable output (for the in-app board / history)
 *   --tool <id>       limit to one tool
 *   --min <0..100>    exit non-zero if any shown tool scores below this (CI gate)
 *
 * No network, no DB. The evidence is the code itself.
 */
import { READINESS_TOOLS, toolById } from "../src/lib/readiness/catalog";
import { reportTool, scorePct } from "../src/lib/readiness/report";
import { createFsReader } from "./readiness-fs-reader";

const ROOT = process.cwd();
const fsReader = createFsReader(ROOT);

const args = process.argv.slice(2);
const json = args.includes("--json");
const only = args[args.indexOf("--tool") + 1];
const minIdx = args.indexOf("--min");
const min = minIdx >= 0 ? Number(args[minIdx + 1]) : null;

const specs = only && args.includes("--tool") ? [toolById(only)].filter(Boolean) : READINESS_TOOLS;
if (specs.length === 0) {
  console.error(`No tool matches --tool ${only}. Known: ${READINESS_TOOLS.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

const reports = specs.map((spec) => reportTool(spec!, fsReader));

if (json) {
  console.log(JSON.stringify({ generatedBy: "scripts/readiness.ts", reports }, null, 2));
} else {
  const glyph = (s: string) => (s === "ready" ? "[x]" : s === "partial" ? "[~]" : "[ ]");
  for (const r of reports) {
    console.log(`\n=== ${r.label}  (${r.surface}) ===`);
    console.log(`Readiness: ${scorePct(r.score)}%   ready ${r.ready} · partial ${r.partial} · gap ${r.gap} of ${r.total}`);
    const dims = Object.entries(r.byDimension)
      .map(([d, v]) => `${d} ${scorePct(v.score)}%`)
      .join("  ·  ");
    console.log(`By dimension: ${dims}`);
    for (const c of r.results) {
      const tag = c.kind === "attested" ? " (attested)" : "";
      console.log(`  ${glyph(c.status)} [${c.dimension}] ${c.title}${tag}`);
      console.log(`        ${c.evidence}`);
    }
  }
  console.log("");
}

if (min != null) {
  const below = reports.filter((r) => scorePct(r.score) < min);
  if (below.length > 0) {
    console.error(`FAIL: ${below.map((r) => `${r.toolId}=${scorePct(r.score)}%`).join(", ")} below --min ${min}`);
    process.exit(1);
  }
}
