/**
 * OWASP posture: the combined compliance deliverable.
 *
 * A LIVE site scan assesses only misconfiguration (A05, via headers). A CODE scan
 * (the static detectors) assesses the injection / access-control / crypto / secrets
 * categories. Neither alone is a full picture, and reporting "not assessed" for the
 * half you did not run is honest but thin. This assembler takes BOTH - plus whether
 * Forcefield is active - and produces ONE OWASP Top 10 posture, with each category
 * marked assessed only by the scan that actually covers it.
 *
 * It also renders that posture as a Markdown artifact a client or auditor can keep:
 * the export side of the compliance tool. Pure: inputs in, posture/string out.
 */
import {
  assessSecurityControls,
  CONTROL_MAP,
  type SecurityControlReport,
  type SecurityFindingLike,
  type ControlStatus,
} from "./security-controls";

/** OWASP ids the CODE detectors can produce (everything the mapping covers except
 *  the live-only security-headers check). Running a code scan means these were
 *  actually assessed, so a clean one reads checked_clear, not not_assessed. */
export const CODE_ASSESSED_OWASP: readonly string[] = Array.from(
  new Set(CONTROL_MAP.filter((m) => m.key !== "security_headers").map((m) => m.owasp)),
);

/** OWASP ids the LIVE site scan assesses (misconfiguration via security headers). */
export const LIVE_ASSESSED_OWASP: readonly string[] = ["A05:2021"];

export interface OwaspPostureInput {
  /** Security findings from a code scan (ScanFinding[] fits structurally). Absent
   *  means no code scan ran, so the code categories read not_assessed. */
  codeFindings?: readonly SecurityFindingLike[];
  /** The live scan ran AND could assess the headers (verdict present/absent, not
   *  unverifiable). Absent/false means A05 was not assessed live. */
  liveHeadersAssessed?: boolean;
  /** True when the live headers check found them MISSING (an A05 gap). */
  liveHeadersMissing?: boolean;
  /** Whether Forcefield protects this target at runtime (compensating control). */
  forcefieldActive?: boolean;
}

/**
 * Assemble one OWASP posture from whatever scans ran. A category is only marked
 * assessed by the scan that covers it: never a clean bill for something no scan
 * looked at.
 */
export function assembleOwaspPosture(input: OwaspPostureInput): SecurityControlReport {
  const findings: SecurityFindingLike[] = [...(input.codeFindings ?? [])];
  if (input.liveHeadersAssessed && input.liveHeadersMissing) {
    findings.push({ title: "Security misconfiguration: core security headers missing", category: "security", severity: "medium" });
  }

  const assessed = new Set<string>();
  if (input.codeFindings !== undefined) for (const id of CODE_ASSESSED_OWASP) assessed.add(id);
  if (input.liveHeadersAssessed) for (const id of LIVE_ASSESSED_OWASP) assessed.add(id);

  return assessSecurityControls(findings, {
    forcefieldActive: input.forcefieldActive,
    assessedOwaspIds: [...assessed],
  });
}

const STATUS_WORD: Record<ControlStatus, string> = {
  gap: "GAP",
  compensated: "COMPENSATED",
  checked_clear: "no issue found",
  not_assessed: "not assessed",
};

/**
 * Render the posture as a Markdown artifact. Deterministic (no timestamp inside -
 * the caller stamps that, so the artifact is reproducible for a given scan). Leads
 * with the honesty note so the document cannot be quoted as a clean bill.
 */
export function renderOwaspPostureMarkdown(report: SecurityControlReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push("# Application security posture (OWASP Top 10 2021)");
  lines.push("");
  lines.push(
    `Summary: ${s.gap} gap(s), ${s.compensated} compensated, ${s.checked_clear} checked (no issue found), ${s.not_assessed} not assessed.`,
  );
  lines.push("");
  lines.push(
    "> \"Not assessed\" means this scan did not check the category, NOT that it passed. " +
      "A category is marked checked only when a scan that covers it ran and found nothing; " +
      "\"compensated\" means the code may be at risk but Forcefield blocks that attack class at the edge.",
  );
  lines.push("");
  lines.push("| Category | Status | CWE | ASVS | Detail |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const a of report.assessments) {
    const cwe = a.cwes.join(", ") || "-";
    const asvs = a.asvs.join(", ") || "-";
    const detail = a.detail.replace(/\|/g, "\\|");
    lines.push(`| ${a.owasp.id} ${a.owasp.title} | ${STATUS_WORD[a.status]} | ${cwe} | ${asvs} | ${detail} |`);
  }
  lines.push("");
  return lines.join("\n");
}
