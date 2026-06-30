/**
 * `npm run self-scan`: dogfood the AI-surface scanner on this repo.
 *
 * Runs the SAME read-only detectors the live /admin/ai-surfaces scan uses over
 * our own source, and prints a deterministic inventory: totals, the by-kind and
 * by-provider breakdown, the ungoverned gap, and a remediation line per
 * ungoverned surface. No network, no writes. Use it to refresh the self-scan
 * case study (docs/pitch/self-scan-case-study.md) or as a pre-demo sanity check.
 *
 * Secret hints are masked by the detector (maskKey); this script never prints a
 * raw credential. A real committed secret surfacing here is a finding to FIX,
 * not to publish.
 */
import path from "node:path";
import { runSelfScan } from "../src/lib/ai-surface/self-scan";

function sortedEntries(rec: Record<string, number>): [string, number][] {
  return Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const root = process.cwd();
const { filesScanned, surfaces, summary, remediations } = runSelfScan(root);

console.log(`\nAI-surface self-scan of ${path.basename(root)}`);
console.log("=".repeat(48));
console.log(`Files scanned:      ${filesScanned}`);
console.log(`AI surfaces found:  ${summary.total}`);
console.log(`Ungoverned:         ${summary.ungoverned}`);

console.log("\nBy kind:");
for (const [k, n] of sortedEntries(summary.byKind)) console.log(`  ${k.padEnd(20)} ${n}`);
console.log("\nBy provider:");
for (const [p, n] of sortedEntries(summary.byProvider)) console.log(`  ${p.padEnd(20)} ${n}`);
console.log("\nBy risk:");
for (const [r, n] of sortedEntries(summary.byRisk)) console.log(`  ${r.padEnd(20)} ${n}`);

const ungoverned = surfaces.filter((s) => !s.governed).sort((a, b) => a.location.localeCompare(b.location));
if (ungoverned.length > 0) {
  console.log("\nUngoverned surfaces (location -> remediation):");
  for (const s of ungoverned) {
    const rem = remediations.find((r) => r.kind === s.kind && r.provider === s.provider);
    console.log(`  [${s.risk}] ${s.kind}/${s.provider} @ ${s.location}`);
    if (rem) console.log(`        -> ${rem.summary} (${rem.priority})`);
  }
}
console.log("");
