/**
 * Pure decision logic for the supply-chain check. The runner
 * (scripts/security/supply-chain.ts) does the fetching; everything here takes
 * plain data and returns findings, so each rule is testable without a network.
 */
import type { Finding, Severity } from "./report";
import type { Ecosystem, ImageRef, LockedPackage } from "./lockfiles";
import { normalizePyName } from "./lockfiles";

// ---------------------------------------------------------------- curated list

export interface KnownPackage {
  id: string;
  ecosystem: Ecosystem;
  name: string;
  versions: string[];
  summary: string;
  safeVersion?: string;
  sources: string[];
}

export interface KnownImage {
  id: string;
  images: string[];
  tags: string[];
  movingTags?: string[];
  digests: string[];
  summary: string;
  sources: string[];
}

export interface WorkflowIndicator {
  fileName: string;
  summary: string;
  sources: string[];
}

export interface KnownCompromised {
  updated: string;
  packages: KnownPackage[];
  images: KnownImage[];
  workflowIndicators: WorkflowIndicator[];
}

function samePackage(ecosystem: Ecosystem, a: string, b: string): boolean {
  return ecosystem === "PyPI" ? normalizePyName(a) === normalizePyName(b) : a === b;
}

export function matchKnownPackages(
  repo: string,
  file: string,
  packages: LockedPackage[],
  known: KnownPackage[],
): Finding[] {
  const out: Finding[] = [];
  for (const p of packages) {
    for (const k of known) {
      if (k.ecosystem !== p.ecosystem || !samePackage(p.ecosystem, k.name, p.name)) continue;
      if (!k.versions.includes("*") && !k.versions.includes(p.version)) continue;
      out.push({
        severity: "critical",
        rule: "known-compromised.package",
        subject: `${repo}:${file}`,
        detail: `${p.name}@${p.version} (${p.ecosystem}) is a known malicious release [${k.id}]. ${k.safeVersion ? `Move to ${k.safeVersion} or later, rebuild from a clean image, and ` : "Remove it and "}rotate every credential the installing machine or runner could read.`,
        source: k.sources[0],
      });
    }
  }
  return out;
}

export function matchKnownImages(repo: string, file: string, refs: ImageRef[], known: KnownImage[]): Finding[] {
  const out: Finding[] = [];
  for (const r of refs) {
    const image = r.image.replace(/^docker\.io\//, "");
    for (const k of known) {
      const names = k.images.map((i) => i.toLowerCase().replace(/^docker\.io\//, ""));
      if (!names.includes(image)) continue;
      const badDigest = r.digest && k.digests.includes(r.digest);
      const badTag = r.tag && k.tags.includes(r.tag);
      const movingTag = !r.digest && (r.tag === null || (k.movingTags ?? []).includes(r.tag));
      if (badDigest || badTag) {
        out.push({
          severity: "critical",
          rule: "known-compromised.image",
          subject: `${repo}:${file}`,
          detail: `${r.image}${r.tag ? `:${r.tag}` : ""}${r.digest ? `@${r.digest}` : ""} is a known malicious image [${k.id}]. Rebuild without it and rotate every secret the container could read.`,
          source: k.sources[0],
        });
      } else if (movingTag) {
        out.push({
          severity: "low",
          rule: "known-compromised.moving-tag",
          subject: `${repo}:${file}`,
          detail: `${r.image}:${r.tag ?? "latest"} is a moving tag that pointed at a malicious build for a window [${k.id}]. Pin a digest, and check whether anything pulled it during that window.`,
          source: k.sources[0],
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------- OSV

export interface OsvQuery {
  package: { ecosystem: Ecosystem; name: string };
  version: string;
}

export const OSV_BATCH_LIMIT = 1000;

export function osvQueries(packages: LockedPackage[]): OsvQuery[] {
  return packages.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface OsvVulnDetail {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  withdrawn?: string;
  severity?: { type: string; score: string }[];
}

export function isMalwareId(id: string): boolean {
  return /^MAL-/.test(id);
}

/** Map an OSV record to our severity. MAL- is always critical. */
export function osvSeverity(v: OsvVulnDetail): Severity | null {
  if (v.withdrawn) return null; // withdrawn records are not vulnerabilities
  if (isMalwareId(v.id)) return "critical";
  const s = (v.database_specific?.severity ?? "").toUpperCase();
  if (s === "CRITICAL") return "critical";
  if (s === "HIGH") return "high";
  if (s === "MODERATE" || s === "MEDIUM") return "medium";
  if (s === "LOW") return "low";
  return null; // unknown: counted, not flagged
}

/**
 * One finding per package@version per file, at the worst severity across its
 * advisories. Only malicious, critical and high become findings; moderate, low
 * and unrated advisories are counted in stats (Dependabot already tracks them).
 */
export function osvFindings(
  repo: string,
  file: string,
  pkg: LockedPackage,
  vulnIds: string[],
  details: Map<string, OsvVulnDetail>,
): Finding | null {
  let worst: Severity | null = null;
  const ids: string[] = [];
  const rank = (s: Severity) => ["critical", "high", "medium", "low", "info"].indexOf(s);
  for (const id of vulnIds) {
    const d = details.get(id) ?? { id };
    const s = osvSeverity(d);
    if (s === "critical" || s === "high") {
      ids.push(id);
      if (!worst || rank(s) < rank(worst)) worst = s;
    }
  }
  if (!worst) return null;
  const malicious = ids.filter(isMalwareId);
  return {
    severity: worst,
    rule: malicious.length ? "osv.malicious" : `osv.${worst}`,
    subject: `${repo}:${file}`,
    detail: malicious.length
      ? `${pkg.name}@${pkg.version} (${pkg.ecosystem}) is flagged MALICIOUS by OSV (${malicious.join(", ")}). Treat any machine that installed it as compromised.`
      : `${pkg.name}@${pkg.version} (${pkg.ecosystem}) has ${worst} advisories: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ` and ${ids.length - 5} more` : ""}.`,
    source: `https://osv.dev/vulnerability/${(malicious[0] ?? ids[0])}`,
  };
}

// ------------------------------------------------------------------ Dependabot

export interface DependabotAlert {
  number: number;
  html_url?: string;
  dependency?: { package?: { ecosystem?: string; name?: string }; manifest_path?: string };
  security_advisory?: { ghsa_id?: string; severity?: string; summary?: string; classification?: string; withdrawn_at?: string | null };
  security_vulnerability?: { vulnerable_version_range?: string };
}

export function dependabotFindings(repo: string, alerts: DependabotAlert[]): { findings: Finding[]; counts: Record<string, number> } {
  const counts: Record<string, number> = { malware: 0, critical: 0, high: 0, medium: 0, low: 0, withdrawn: 0 };
  const findings: Finding[] = [];
  for (const a of alerts) {
    const adv = a.security_advisory ?? {};
    if (adv.withdrawn_at) {
      // GitHub withdrew the advisory (not a real vulnerability); counted, not flagged.
      counts.withdrawn += 1;
      continue;
    }
    const sev = (adv.severity ?? "").toLowerCase();
    const malware = (adv.classification ?? "").toLowerCase() === "malware";
    const pkg = a.dependency?.package?.name ?? "?";
    const where = a.dependency?.manifest_path ?? "?";
    if (malware) counts.malware += 1;
    else if (sev in counts) counts[sev] += 1;
    if (!malware && sev !== "critical" && sev !== "high") continue;
    findings.push({
      severity: malware ? "critical" : (sev as Severity),
      rule: malware ? "dependabot.malware" : `dependabot.${sev}`,
      subject: `${repo}:${where}`,
      detail: `${malware ? "MALWARE advisory" : `${sev} advisory`} ${adv.ghsa_id ?? ""} on ${pkg}${a.security_vulnerability?.vulnerable_version_range ? ` (${a.security_vulnerability.vulnerable_version_range})` : ""}: ${adv.summary ?? ""}`.trim(),
      source: a.html_url,
    });
  }
  return { findings, counts };
}

// ------------------------------------------------------------- GhostAction

export interface WorkflowCommit {
  sha: string;
  /** Branches this commit was seen on during the sweep. */
  refs: string[];
  onDefaultBranch: boolean;
  author: string;
  committedAt: string;
  message: string;
  workflowFiles: string[];
  /** Pull requests GitHub associates with the commit. */
  pulls: { number: number; state: string; merged_at: string | null; html_url?: string }[];
}

/**
 * A workflow change that never went through a merged pull request is how the
 * GhostAction campaign spread: a stolen token pushes a "security audit"
 * workflow that runs on push and sends the repository's secrets away. A commit
 * reviewed and merged through a PR is fine; anything else is surfaced.
 *
 *   default branch, no merged PR   -> high  (it is live and runs with secrets)
 *   other branch, no PR at all     -> medium (a pushed branch runs on: push too)
 *   other branch, open PR          -> low   (normal work in progress, listed)
 * A filename on the indicator list raises the severity one step.
 */
export function ghostActionFindings(repo: string, commits: WorkflowCommit[], indicators: WorkflowIndicator[]): Finding[] {
  const out: Finding[] = [];
  const bump: Record<Severity, Severity> = { critical: "critical", high: "critical", medium: "high", low: "medium", info: "low" };
  for (const c of commits) {
    if (c.pulls.some((p) => p.merged_at)) continue;
    const openPr = c.pulls.find((p) => p.state === "open");
    let severity: Severity = c.onDefaultBranch ? "high" : openPr ? "low" : "medium";
    const hit = indicators.filter((i) => c.workflowFiles.some((f) => f.split("/").pop() === i.fileName));
    if (hit.length) severity = bump[severity];
    const where = c.onDefaultBranch ? "the default branch" : `branch ${c.refs.slice(0, 3).join(", ")}`;
    out.push({
      severity,
      rule: c.onDefaultBranch ? "ghostaction.direct-push" : openPr ? "ghostaction.unmerged-pr" : "ghostaction.no-pr",
      subject: `${repo}@${c.sha.slice(0, 7)}`,
      detail:
        `Workflow change on ${where} by ${c.author} at ${c.committedAt} is not part of a merged pull request` +
        `${openPr ? ` (open PR #${openPr.number})` : ""}. Files: ${c.workflowFiles.join(", ") || "(not listed)"}. ` +
        `Message: "${c.message.split("\n")[0].slice(0, 80)}".` +
        (hit.length ? ` Filename matches a known campaign indicator: ${hit.map((h) => h.fileName).join(", ")}.` : ""),
      source: openPr?.html_url ?? `https://github.com/${repo}/commit/${c.sha}`,
    });
  }
  return out;
}
