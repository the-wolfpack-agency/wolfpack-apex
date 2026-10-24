/**
 * One report shape for every scheduled security check.
 *
 * Each check (supply chain, Entra audit, AI spend, deployed surface) produces a
 * list of findings. This file turns that list into the three things a check
 * owes its reader: a JSON file a machine can diff, a markdown file a person can
 * read, and an exit code CI can act on. Keeping it in one place means the four
 * checks cannot drift into four different ideas of what "a finding" is.
 *
 * EXIT CODES
 *   0  ran, nothing at or above the failing severity (or skipped on purpose)
 *   1  ran, found something at or above the failing severity
 *   2  could not run (an error, not a verdict)
 *
 * A SKIP IS NOT A PASS. A check that is missing its credential reports
 * `skipped` with the name of what to configure, exits 0 so a dark workflow does
 * not train people to ignore red, and says so in the first line of the output.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface Finding {
  severity: Severity;
  /** Short machine id of the rule that fired, e.g. "dependabot.malware". */
  rule: string;
  /** What the finding is about: a repo, an app, a site, a resource. */
  subject: string;
  /** One or two plain sentences: what is wrong and why it matters. */
  detail: string;
  /** Where the evidence came from (advisory id, URL, API path). */
  source?: string;
}

export interface CheckReport {
  check: string;
  generatedAt: string;
  /** Set when the check did not run, with the reason and what to configure. */
  skipped?: string;
  findings: Finding[];
  /** Counts and facts about what was examined, so "0 findings" can be judged. */
  stats: Record<string, number | string>;
  /** Limits and caveats the reader needs to interpret the result. */
  notes: string[];
}

export function newReport(check: string, now: Date = new Date()): CheckReport {
  return { check, generatedAt: now.toISOString(), findings: [], stats: {}, notes: [] };
}

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** True when any finding is at or above `threshold` (default: medium). */
export function hasFailingFindings(r: CheckReport, threshold: Severity = "medium"): boolean {
  const limit = severityRank(threshold);
  return r.findings.some((f) => severityRank(f.severity) <= limit);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.subject.localeCompare(b.subject) ||
      a.rule.localeCompare(b.rule),
  );
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** Markdown cells cannot hold a raw pipe or newline. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdown(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`## Security check: ${r.check}`);
  lines.push("");
  lines.push(`Generated ${r.generatedAt}`);
  lines.push("");
  if (r.skipped) {
    lines.push(`**SKIPPED.** ${r.skipped}`);
    lines.push("");
  } else {
    const c = countBySeverity(r.findings);
    lines.push(
      `**Findings:** ${r.findings.length} (critical ${c.critical}, high ${c.high}, medium ${c.medium}, low ${c.low}, info ${c.info})`,
    );
    lines.push("");
  }
  const statKeys = Object.keys(r.stats);
  if (statKeys.length) {
    lines.push("### What was examined");
    lines.push("");
    for (const k of statKeys) lines.push(`- ${k}: ${r.stats[k]}`);
    lines.push("");
  }
  if (r.findings.length) {
    lines.push("### Findings");
    lines.push("");
    lines.push("| Severity | Rule | Subject | Detail | Source |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const f of sortFindings(r.findings)) {
      lines.push(
        `| ${f.severity} | ${cell(f.rule)} | ${cell(f.subject)} | ${cell(f.detail)} | ${cell(f.source ?? "")} |`,
      );
    }
    lines.push("");
  }
  if (r.notes.length) {
    lines.push("### Notes");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface CliOptions {
  outDir: string;
  failOn: Severity;
}

/** `--out <dir>` and `--fail-on <severity>`; defaults keep output out of git. */
export function parseCliOptions(argv: string[], defaultOut: string): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const failOn = (get("--fail-on") ?? "medium") as Severity;
  if (!SEVERITY_ORDER.includes(failOn)) {
    throw new Error(`--fail-on must be one of ${SEVERITY_ORDER.join(", ")}`);
  }
  return { outDir: get("--out") ?? defaultOut, failOn };
}

/**
 * Write JSON + markdown, print the markdown, append it to the GitHub job
 * summary when running in Actions, and return the exit code.
 */
export function emitReport(r: CheckReport, opts: CliOptions): number {
  r.findings = sortFindings(r.findings);
  mkdirSync(opts.outDir, { recursive: true });
  const md = renderMarkdown(r);
  writeFileSync(join(opts.outDir, `${r.check}.json`), JSON.stringify(r, null, 2) + "\n");
  writeFileSync(join(opts.outDir, `${r.check}.md`), md + "\n");
  process.stdout.write(md + "\n");
  process.stdout.write(`\nReport written to ${join(opts.outDir, r.check)}.{json,md}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    } catch {
      process.stderr.write("Could not append to GITHUB_STEP_SUMMARY; the report files above are complete.\n");
    }
  }
  if (r.skipped) return 0;
  return hasFailingFindings(r, opts.failOn) ? 1 : 0;
}

/** Run `fn` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
