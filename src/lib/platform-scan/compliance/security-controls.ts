/**
 * Security-control mapping: turn the raw security findings our scanners produce
 * (the static code detectors, the Forcefield runtime engine, the campaign detector)
 * into the language a COMPLIANCE deliverable speaks - recognized framework controls
 * (OWASP Top 10 2021, CWE, OWASP ASVS). This is the layer that lets the deep audits
 * we have built feed a compliance report: "scanned for A03 Injection, found 1 gap"
 * rather than a raw list of detector titles.
 *
 * Honest by construction (see the platform-scan truthfulness standard):
 *   - "gap"           a finding maps to this control (evidence of a violation).
 *   - "checked_clear" the scanner assesses this control and found nothing. A scan
 *                     is not a proof, so the detail says "no issue found", not "met".
 *   - "compensated"   the code may be at risk, but Forcefield blocks the attack
 *                     class at the edge/runtime, so the control is covered in depth.
 *   - "not_assessed"  the scanner does not cover this control. NEVER reported as
 *                     met - absence of a check is not evidence of compliance.
 *
 * Pure: findings in, control assessment out. No I/O, no model.
 */

export type ControlStatus = "gap" | "checked_clear" | "compensated" | "not_assessed";

/** One OWASP Top 10 2021 category. The framework spine the assessment rolls up to. */
export interface OwaspCategory {
  id: string; // e.g. "A03:2021"
  title: string; // e.g. "Injection"
}

export const OWASP_TOP_10_2021: readonly OwaspCategory[] = [
  { id: "A01:2021", title: "Broken Access Control" },
  { id: "A02:2021", title: "Cryptographic Failures" },
  { id: "A03:2021", title: "Injection" },
  { id: "A04:2021", title: "Insecure Design" },
  { id: "A05:2021", title: "Security Misconfiguration" },
  { id: "A06:2021", title: "Vulnerable and Outdated Components" },
  { id: "A07:2021", title: "Identification and Authentication Failures" },
  { id: "A08:2021", title: "Software and Data Integrity Failures" },
  { id: "A09:2021", title: "Security Logging and Monitoring Failures" },
  { id: "A10:2021", title: "Server-Side Request Forgery (SSRF)" },
];

/** How one kind of finding maps onto the frameworks. `match` tests a finding's
 *  title/category; `owasp`/`cwe`/`asvs` place it. `forcefieldCompensates` marks the
 *  attack classes Forcefield blocks at runtime (so a code-level gap is covered in
 *  depth when the engine is active). */
export interface ControlMapping {
  key: string;
  match: RegExp;
  owasp: string; // OWASP Top 10 id
  cwe: string;
  asvs: string;
  forcefieldCompensates: boolean;
}

// Ordered: first match wins. Titles come from the static detectors and the
// Forcefield payload/campaign vocabulary.
export const CONTROL_MAP: readonly ControlMapping[] = [
  { key: "sql_injection", match: /sql injection/i, owasp: "A03:2021", cwe: "CWE-89", asvs: "V5.3.4", forcefieldCompensates: true },
  { key: "xss", match: /xss|dangerouslysetinnerhtml|cross-site scripting/i, owasp: "A03:2021", cwe: "CWE-79", asvs: "V5.3.3", forcefieldCompensates: true },
  { key: "code_injection", match: /code injection|eval\(|new function/i, owasp: "A03:2021", cwe: "CWE-95", asvs: "V5.2.4", forcefieldCompensates: false },
  { key: "command_injection", match: /command injection/i, owasp: "A03:2021", cwe: "CWE-78", asvs: "V5.3.8", forcefieldCompensates: true },
  { key: "path_traversal", match: /path traversal/i, owasp: "A01:2021", cwe: "CWE-22", asvs: "V12.3.1", forcefieldCompensates: true },
  { key: "idor", match: /idor|ownership scope|object level/i, owasp: "A01:2021", cwe: "CWE-639", asvs: "V4.2.1", forcefieldCompensates: true },
  { key: "missing_authz", match: /no visible authorization|missing authorization|unauthenticated|missing authentication/i, owasp: "A01:2021", cwe: "CWE-862", asvs: "V4.1.1", forcefieldCompensates: false },
  { key: "ssrf", match: /ssrf|server-side request forgery/i, owasp: "A10:2021", cwe: "CWE-918", asvs: "V12.6.1", forcefieldCompensates: true },
  { key: "ssti", match: /ssti|template injection/i, owasp: "A03:2021", cwe: "CWE-1336", asvs: "V5.2.5", forcefieldCompensates: true },
  { key: "log4shell", match: /log4shell|jndi/i, owasp: "A03:2021", cwe: "CWE-917", asvs: "V5.2.5", forcefieldCompensates: true },
  { key: "crlf", match: /crlf|response splitting|header injection/i, owasp: "A03:2021", cwe: "CWE-113", asvs: "V5.3.9", forcefieldCompensates: true },
  { key: "nosql_injection", match: /nosql/i, owasp: "A03:2021", cwe: "CWE-943", asvs: "V5.3.4", forcefieldCompensates: true },
  { key: "open_redirect", match: /open redirect/i, owasp: "A01:2021", cwe: "CWE-601", asvs: "V5.1.5", forcefieldCompensates: true },
  { key: "weak_hash", match: /weak hash/i, owasp: "A02:2021", cwe: "CWE-328", asvs: "V6.2.3", forcefieldCompensates: false },
  { key: "hardcoded_secret", match: /hardcoded secret|secret written to a log|credential written to a log|secret.*log/i, owasp: "A05:2021", cwe: "CWE-798", asvs: "V6.4.1", forcefieldCompensates: false },
  { key: "auth_abuse", match: /credential stuffing|brute force|auth_abuse|auth-surface/i, owasp: "A07:2021", cwe: "CWE-307", asvs: "V11.1.1", forcefieldCompensates: true },
  { key: "enumeration", match: /enumeration|recon|fuzzing|campaign/i, owasp: "A01:2021", cwe: "CWE-799", asvs: "V11.1.2", forcefieldCompensates: true },
];

/** The minimal finding shape this reads - the common ground between a static
 *  ScanFinding and a Forcefield/campaign signal. */
export interface SecurityFindingLike {
  title: string;
  category?: string; // only "security"-category findings are mapped
  severity?: string;
}

export interface ControlAssessment {
  owasp: OwaspCategory;
  status: ControlStatus;
  cwes: string[];
  asvs: string[];
  /** Plain-language, client-readable. No raw detector titles. */
  detail: string;
  /** How many findings mapped to this control. */
  findingCount: number;
}

export interface SecurityControlReport {
  assessments: ControlAssessment[];
  /** Rollup: counts by status, for a report header. */
  summary: Record<ControlStatus, number>;
}

/**
 * Assess the OWASP Top 10 from a set of security findings.
 *
 * A control with mapped findings is a `gap` - OR `compensated` when Forcefield is
 * active AND every mapped finding is an attack class the engine blocks at runtime.
 * A control the scanner assesses with no findings is `checked_clear`. A control no
 * mapping covers is `not_assessed` (never silently "met").
 */
export function assessSecurityControls(
  findings: readonly SecurityFindingLike[],
  opts: { forcefieldActive?: boolean } = {},
): SecurityControlReport {
  const security = findings.filter((f) => (f.category ?? "security") === "security");

  // Which OWASP ids does our scanner actually assess? (every id a mapping targets)
  const assessedOwasp = new Set(CONTROL_MAP.map((m) => m.owasp));

  // Group mapped findings by OWASP id.
  const byOwasp = new Map<string, { cwes: Set<string>; asvs: Set<string>; count: number; allCompensated: boolean }>();
  for (const f of security) {
    const m = CONTROL_MAP.find((mm) => mm.match.test(f.title));
    if (!m) continue;
    const e = byOwasp.get(m.owasp) ?? { cwes: new Set<string>(), asvs: new Set<string>(), count: 0, allCompensated: true };
    e.cwes.add(m.cwe);
    e.asvs.add(m.asvs);
    e.count++;
    e.allCompensated = e.allCompensated && m.forcefieldCompensates;
    byOwasp.set(m.owasp, e);
  }

  const assessments: ControlAssessment[] = OWASP_TOP_10_2021.map((cat) => {
    const hit = byOwasp.get(cat.id);
    if (hit) {
      const compensated = opts.forcefieldActive === true && hit.allCompensated;
      return {
        owasp: cat,
        status: compensated ? "compensated" : "gap",
        cwes: [...hit.cwes].sort(),
        asvs: [...hit.asvs].sort(),
        findingCount: hit.count,
        detail: compensated
          ? `${hit.count} code-level finding(s) in this category, but Forcefield blocks this attack class at the edge, so it is covered in depth. Fix the code to remove the dependency on the compensating control.`
          : `${hit.count} finding(s) map to this category. Review and remediate; see the mapped CWE(s).`,
      };
    }
    if (assessedOwasp.has(cat.id)) {
      return { owasp: cat, status: "checked_clear", cwes: [], asvs: [], findingCount: 0, detail: "Scanned for this category; no issue was found. A scan is evidence, not a proof." };
    }
    return { owasp: cat, status: "not_assessed", cwes: [], asvs: [], findingCount: 0, detail: "This scanner does not assess this category. Absence of a check is not evidence of compliance." };
  });

  const summary: Record<ControlStatus, number> = { gap: 0, checked_clear: 0, compensated: 0, not_assessed: 0 };
  for (const a of assessments) summary[a.status]++;
  return { assessments, summary };
}
