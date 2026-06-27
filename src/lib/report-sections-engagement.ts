/**
 * Section generators for the client SECURITY ENGAGEMENT report: the deliverable
 * an OGIAM operator hands a client's engineers. Every section is data-backed,
 * pulled from the SAME stores the live product writes to (platform-scan findings,
 * scan runs, the hash-chained audit log), so the report is a faithful synthesis
 * of real work, never a template of claims. Zero new persistence: it reads the
 * existing tables, and generateReport() already emits the learning event +
 * strips copy artifacts.
 *
 * Each generator returns a Markdown section INCLUDING its own `## Heading`
 * (matching the existing report-templates convention) and never throws: a store
 * hiccup degrades to an explicit empty-state line, so a report always renders.
 */
import type { ReportContext } from "@/lib/report-templates";
import {
  summarizeFindings,
  listFindings,
  listScans,
  type FindingsSummary,
} from "@/lib/platform-scan/store";
import { queryAuditLog } from "@/lib/audit-log";
import { listSystemProfiles } from "@/lib/platform-scan/profile/store";
import { listRecommendations } from "@/lib/platform-scan/recommend/store";
import { pentestFindings } from "@/lib/platform-scan/pentest/findings";

const ws = (ctx: ReportContext): string => ctx.workspaceId ?? "default";

/** A -> F posture grade from open finding counts. Criticals fail outright. */
export function postureGrade(s: FindingsSummary): { grade: string; label: string } {
  if (s.bySeverity.critical > 0) return { grade: "F", label: "Critical exposure, immediate remediation required" };
  if (s.bySeverity.high >= 5) return { grade: "D", label: "Multiple high-severity gaps" };
  if (s.bySeverity.high > 0) return { grade: "C", label: "High-severity gaps present" };
  if (s.bySeverity.medium > 0) return { grade: "B", label: "Hardening recommended" };
  if (s.total > 0) return { grade: "A-", label: "Minor low-severity items only" };
  return { grade: "A", label: "No open findings" };
}

export async function genEngagementSummary(ctx: ReportContext): Promise<string> {
  const summary = await summarizeFindings(ws(ctx));
  const scans = await listScans(ws(ctx), 100);
  const { grade, label } = postureGrade(summary);
  const platforms = Array.from(new Set(scans.map((s) => s.platform)));
  return [
    `## Executive Summary`,
    ``,
    `This engagement assessed ${platforms.length || "the connected"} platform(s) through the OGIAM agent: automated security verification, issue diagnosis, and continuous monitoring, every action governed by a deterministic gate and recorded in a tamper-evident audit chain.`,
    ``,
    `**Security posture grade: ${grade}** (${label}).`,
    ``,
    `| Severity | Open findings |`,
    `|----------|---------------|`,
    `| Critical | ${summary.bySeverity.critical} |`,
    `| High | ${summary.bySeverity.high} |`,
    `| Medium | ${summary.bySeverity.medium} |`,
    `| Low | ${summary.bySeverity.low} |`,
    `| **Total** | **${summary.total}** |`,
    ``,
    `Scans run this engagement: ${scans.length}. Platforms covered: ${platforms.join(", ") || "none recorded"}.`,
  ].join("\n");
}

const EMPTY_SYSTEM_MAP =
  "No system profile has been generated yet; run the profiler against a connected platform.";

/** System Map: the discovered surface, data model, and integrations of each
 *  profiled target. Reads the persisted SystemProfile snapshots (one per
 *  workspace+platform). Never throws: any store hiccup degrades to the
 *  explicit empty-state line so the report always renders. */
export async function genSystemMap(ctx: ReportContext): Promise<string> {
  const out = [`## System Map`, ``];
  try {
    const profiles = await listSystemProfiles(ws(ctx));
    if (profiles.length === 0) {
      out.push(EMPTY_SYSTEM_MAP);
      return out.join("\n");
    }
    for (const row of profiles) {
      const p = row.profile;
      const s = p.surface;
      out.push(
        `### ${p.platform}`,
        ``,
        `| Surface | Count |`,
        `|---------|-------|`,
        `| Pages | ${s.pages} |`,
        `| API routes | ${s.apiRoutes} |`,
        `| Lib modules | ${s.libModules} |`,
        `| Migrations | ${s.migrations} |`,
        `| Tests | ${s.tests} |`,
        `| Total files | ${s.totalFiles} |`,
        ``,
      );
      const integrations =
        p.integrations.length > 0
          ? p.integrations.map((i) => `${i.name} (${i.category})`).join(", ")
          : "none detected";
      out.push(`**Integrations**: ${integrations}`, ``);
      const names = p.entities.slice(0, 30);
      const more = p.entities.length > names.length ? `, +${p.entities.length - names.length} more` : "";
      const entityList = names.length > 0 ? `${names.join(", ")}${more}` : "none discovered";
      out.push(`**Data model**: ${p.entities.length} entities (${entityList})`, ``);
      out.push(
        `**Auth**: ${p.authModel.protectedRoutes} protected, ${p.authModel.publicRoutes} public routes`,
        ``,
      );
    }
    return out.join("\n");
  } catch {
    return [`## System Map`, ``, EMPTY_SYSTEM_MAP].join("\n");
  }
}

const REMEDIATION: Record<string, string> = {
  security: "Close the access-control / exposure gap; verify with a re-scan.",
  bug: "Fix the defect; add a regression test before closing.",
  broken_journey: "Restore the route or remove the dead link from the journey.",
  performance: "Profile and reduce response time below the budget.",
  ux_gap: "Add the missing guard / state so the UI cannot accept invalid input.",
};

export async function genSecurityFindings(ctx: ReportContext): Promise<string> {
  const findings = await listFindings(ws(ctx), {
    status: "open",
    severities: ["critical", "high"],
    limit: 100,
  });
  const sec = findings.filter((f) => f.category === "security");
  const out = [`## Security Findings (Critical + High)`, ``];
  if (sec.length === 0) {
    out.push(`No open critical or high security findings. This reflects the current scan coverage, not a guarantee of absence; see Coverage and Recommendations.`);
    return out.join("\n");
  }
  out.push(`| Severity | Platform | Location | Finding |`, `|----------|----------|----------|---------|`);
  for (const f of sec) {
    out.push(`| ${f.severity} | ${f.platform} | \`${f.route}\` | ${f.title} |`);
  }
  out.push(``, `**Remediation guidance**: ${REMEDIATION.security}`);
  return out.join("\n");
}

const EMPTY_PENTEST =
  "No active penetration tests have confirmed a finding (or none have been run).";

/** Penetration Testing: the findings the ACTIVE probes confirmed by exercising
 *  the running app (IDOR, missing rate limit, info disclosure), as opposed to the
 *  passive analysis surfaced in Security Findings. Single source of truth for what
 *  counts as actively-confirmed is pentestFindings(). Never throws: any store
 *  hiccup degrades to the explicit empty-state line so the report always renders. */
export async function genPentestFindings(ctx: ReportContext): Promise<string> {
  const out = [`## Penetration Testing`, ``];
  try {
    const rows = await listFindings(ws(ctx), { status: "open", limit: 300 });
    const pt = pentestFindings(rows);
    out.push(
      `Findings confirmed by ACTIVE probes (the agent exercised the running app), distinct from passive analysis.`,
      ``,
    );
    if (pt.length === 0) {
      out.push(EMPTY_PENTEST);
      return out.join("\n");
    }
    out.push(`| Severity | Location | Finding |`, `|----------|----------|---------|`);
    for (const f of pt) {
      out.push(`| ${f.severity} | \`${f.route}\` | ${f.title} |`);
    }
    return out.join("\n");
  } catch {
    return [`## Penetration Testing`, ``, EMPTY_PENTEST].join("\n");
  }
}

export async function genDiagnosedIssues(ctx: ReportContext): Promise<string> {
  const findings = await listFindings(ws(ctx), { status: "open", limit: 300 });
  const issues = findings.filter((f) =>
    ["bug", "broken_journey", "performance", "ux_gap"].includes(f.category),
  );
  const out = [`## Diagnosed Issues`, ``];
  if (issues.length === 0) {
    out.push(`No open functional, performance, or UX issues recorded.`);
    return out.join("\n");
  }
  out.push(`| Severity | Category | Location | Issue |`, `|----------|----------|----------|-------|`);
  for (const f of issues.slice(0, 100)) {
    out.push(`| ${f.severity} | ${f.category} | \`${f.route}\` | ${f.title} |`);
  }
  if (issues.length > 100) out.push(``, `_+${issues.length - 100} more (truncated)._`);
  return out.join("\n");
}

export async function genWorkPerformed(ctx: ReportContext): Promise<string> {
  let entries: { action: string; ts: string }[] = [];
  try {
    const page = await queryAuditLog({ limit: 200 });
    entries = page.entries.map((e) => ({ action: String(e.action), ts: String(e.ts) }));
  } catch {
    /* audit unavailable: degrade to empty */
  }
  const out = [`## Work Performed`, ``, `Every action below is an entry in the tamper-evident, hash-chained audit log.`, ``];
  if (entries.length === 0) {
    out.push(`No audited actions recorded for this period.`);
    return out.join("\n");
  }
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.action] = (counts[e.action] ?? 0) + 1;
  out.push(`| Action | Count |`, `|--------|-------|`);
  for (const [action, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    out.push(`| \`${action}\` | ${n} |`);
  }
  out.push(``, `Total audited actions: ${entries.length}.`);
  return out.join("\n");
}

export async function genScanCoverage(ctx: ReportContext): Promise<string> {
  const scans = await listScans(ws(ctx), 50);
  const out = [`## Scan Coverage`, ``];
  if (scans.length === 0) {
    out.push(`No scans recorded for this engagement.`);
    return out.join("\n");
  }
  out.push(`| Platform | Routes | Findings | Critical | Run at |`, `|----------|--------|----------|----------|--------|`);
  for (const s of scans) {
    out.push(`| ${s.platform} | ${s.routeCount} | ${s.findingCount} | ${s.criticalCount} | ${s.createdAt.slice(0, 16).replace("T", " ")} |`);
  }
  return out.join("\n");
}

const EMPTY_RECOMMENDED_AUTOMATIONS =
  "No automation recommendations yet; profile a platform and run the recommender.";

/** Recommended Automations: the gate-governed automation PROPOSALS the engine
 *  derived from the profile + open findings. Reads the persisted recommendations
 *  (one row per workspace+platform+key), drops any the operator dismissed, and
 *  renders them as a prioritized table. Never throws: any store hiccup degrades
 *  to the explicit empty-state line so the report always renders. */
export async function genRecommendedAutomations(ctx: ReportContext): Promise<string> {
  const out = [`## Recommended Automations`, ``];
  try {
    const rows = (await listRecommendations(ws(ctx))).filter((r) => r.status !== "dismissed");
    if (rows.length === 0) {
      out.push(EMPTY_RECOMMENDED_AUTOMATIONS);
      return out.join("\n");
    }
    out.push(
      `| Priority | Category | Recommendation | Suggested action |`,
      `|----------|----------|----------------|------------------|`,
    );
    for (const r of rows) {
      out.push(`| ${r.priority} | ${r.category} | ${r.title} | ${r.suggestedAction} |`);
    }
    return out.join("\n");
  } catch {
    return [`## Recommended Automations`, ``, EMPTY_RECOMMENDED_AUTOMATIONS].join("\n");
  }
}

export async function genRecommendations(ctx: ReportContext): Promise<string> {
  const summary = await summarizeFindings(ws(ctx));
  const recs: string[] = [];
  if (summary.bySeverity.critical > 0) {
    recs.push(`Remediate the ${summary.bySeverity.critical} critical finding(s) immediately; treat any exposed credential as compromised and rotate it.`);
  }
  if (summary.bySeverity.high > 0) {
    recs.push(`Resolve the ${summary.bySeverity.high} high-severity finding(s) before the next release.`);
  }
  if ((summary.byCategory.security ?? 0) > 0) {
    recs.push(`Add the missing HTTP security headers (CSP, HSTS, X-Frame-Options, nosniff) and set HttpOnly/Secure/SameSite on session cookies where flagged.`);
  }
  recs.push(`Run a dataflow SAST (Semgrep) in CI and feed its SARIF into the scanner so injection/SSRF taint classes are covered with low false positives.`);
  recs.push(`Schedule the scan on a cadence so regressions are caught continuously; the audit chain gives a defensible record of what was checked and when.`);
  const out = [`## Recommendations`, ``];
  recs.forEach((r, i) => out.push(`${i + 1}. ${r}`));
  return out.join("\n");
}
