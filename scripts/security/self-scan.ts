/**
 * Gate and report for the AgenticQA security self-scan.
 *
 *   npx tsx scripts/security/self-scan.ts static   --scan scan-results.json [--baseline .agenticqa/scan-baseline.json]
 *   npx tsx scripts/security/self-scan.ts pentest  --results pentest-results.json
 *   npx tsx scripts/security/self-scan.ts combine  (reads SELF_SCAN_* env from job outputs)
 *   npx tsx scripts/security/self-scan.ts baseline --scan scan-results.json --note "why" [--baseline <path>]
 *
 * `static`, `pentest` and `combine` run in security-self-scan.yml. They write
 * numbers to $GITHUB_OUTPUT, a markdown report to --md (default
 * self-scan-<cmd>.md) and the job summary. Details (files, rules, messages)
 * are printed only when the repository is private or the run is local
 * (report.ts `isRedacted`). Exit 2 when the input is missing or unreadable:
 * the gate fails closed rather than reading an absent scan as a clean one.
 *
 * `baseline` is the ONLY way the baseline changes. Run it locally against a
 * scan of the commit you are reviewing, read the diff, and commit it in a PR.
 * CI never writes the baseline (docs/security/self-scan.md).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isRedacted } from "./lib/report";
import {
  baselineFromScan,
  evaluatePentest,
  evaluateStatic,
  parseBaseline,
  renderCombined,
  renderStatic,
  staticOutputs,
  type CombinedInput,
  type ScanResults,
} from "./lib/self-scan";

const DEFAULT_BASELINE = ".agenticqa/scan-baseline.json";

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
}

function writeOutputs(values: Record<string, number | string | boolean>): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  process.stdout.write(lines.join("\n") + "\n");
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, lines.join("\n") + "\n");
}

function emit(md: string, path: string): void {
  writeFileSync(path, md + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

function readJson(path: string | undefined, what: string): unknown {
  if (!path) throw new Error(`missing --${what}`);
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    // JSON.parse messages quote the input, and the input is scan output.
    throw new Error(`${path} is not valid JSON`);
  }
}

function runStatic(argv: string[]): number {
  const scan = readJson(arg(argv, "--scan"), "scan") as ScanResults;
  const baselinePath = arg(argv, "--baseline") ?? DEFAULT_BASELINE;
  let hashes: string[];
  try {
    hashes = parseBaseline(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    // No baseline means every finding is new. That is the honest reading of a
    // missing file, and it fails loudly instead of quietly creating one.
    process.stderr.write(`Baseline ${baselinePath} unreadable (${(e as Error).name}); treating every finding as new.\n`);
    hashes = [];
  }
  const gate = evaluateStatic(scan, hashes);
  writeOutputs(staticOutputs(gate));
  emit(renderStatic(gate, isRedacted()), arg(argv, "--md") ?? "self-scan-static.md");
  return 0;
}

function runPentest(argv: string[]): number {
  const g = evaluatePentest(readJson(arg(argv, "--results"), "results"));
  writeOutputs({ pentest_ran: g.ran, pentest_findings: g.findings, pentest_confirmed: g.confirmed, pentest_confirmed_critical_high: g.confirmedCriticalHigh });
  const md = [
    "## Pentest validation",
    "",
    g.ran
      ? `**${g.findings}** candidate findings examined, **${g.confirmed}** confirmed (${g.confirmedCriticalHigh} critical/high).`
      : "**Did not run.** self_hack.py returned no phase 2 result (PentestAgent missing or failed). This is an error, not a pass.",
    "",
  ].join("\n");
  emit(md, arg(argv, "--md") ?? "self-scan-pentest.md");
  return 0;
}

function runCombine(argv: string[]): number {
  const e = process.env;
  const input: CombinedInput = {
    staticResult: e.SELF_SCAN_STATIC_RESULT ?? "",
    pentestResult: e.SELF_SCAN_PENTEST_RESULT ?? "",
    dependencyResult: e.SELF_SCAN_DEPENDENCY_RESULT ?? "",
    totalFindings: e.SELF_SCAN_TOTAL_FINDINGS ?? "",
    totalCritical: e.SELF_SCAN_TOTAL_CRITICAL ?? "",
    riskLevel: e.SELF_SCAN_RISK_LEVEL ?? "",
    newFindings: e.SELF_SCAN_NEW_FINDINGS ?? "",
    newCriticalHigh: e.SELF_SCAN_NEW_CRITICAL_HIGH ?? "",
    scannerErrors: e.SELF_SCAN_SCANNER_ERRORS ?? "",
    pentestRan: e.SELF_SCAN_PENTEST_RAN ?? "",
    pentestConfirmed: e.SELF_SCAN_PENTEST_CONFIRMED ?? "",
    pentestConfirmedCriticalHigh: e.SELF_SCAN_PENTEST_CONFIRMED_CRITICAL_HIGH ?? "",
    depHigh: e.SELF_SCAN_DEP_HIGH ?? "",
    depCritical: e.SELF_SCAN_DEP_CRITICAL ?? "",
  };
  emit(renderCombined(input), arg(argv, "--md") ?? "combined-report.md");
  return 0;
}

function runBaseline(argv: string[]): number {
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stderr.write("The baseline is changed by a reviewed commit, never from CI.\n");
    return 2;
  }
  const note = arg(argv, "--note");
  if (!note) {
    process.stderr.write('--note "<who and why>" is required so the baseline change reads as a decision in review.\n');
    return 2;
  }
  const scan = readJson(arg(argv, "--scan"), "scan") as ScanResults;
  const path = arg(argv, "--baseline") ?? DEFAULT_BASELINE;
  let before: string[] = [];
  try {
    before = parseBaseline(readFileSync(path, "utf8"));
  } catch {
    /* first baseline */
  }
  const next = baselineFromScan(scan, note);
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  const prev = new Set(before);
  const added = next.finding_hashes.filter((h) => !prev.has(h)).length;
  const removed = before.filter((h) => !next.finding_hashes.includes(h)).length;
  process.stdout.write(`Wrote ${path}: ${next.total} fingerprints (+${added} accepted, -${removed} gone). Review the diff and commit it in a PR.\n`);
  return 0;
}

const COMMANDS: Record<string, (argv: string[]) => number> = {
  static: runStatic,
  pentest: runPentest,
  combine: runCombine,
  baseline: runBaseline,
};

function main(): number {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    process.stderr.write(`usage: self-scan.ts <${Object.keys(COMMANDS).join("|")}> ...\n`);
    return 2;
  }
  try {
    return fn(rest);
  } catch (e) {
    process.stderr.write(`self-scan ${cmd}: ${(e as Error).message}\n`);
    return 2;
  }
}

process.exit(main());
