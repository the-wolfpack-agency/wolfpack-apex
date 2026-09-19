/**
 * Probe intelligence: name WHAT an agent is scanning for, not just "a sensitive
 * path". When a probe hits /actuator/env we can say "Spring environment
 * variables exposed (CWE-200, critical)" instead of a generic flag.
 *
 * REUSE, NOT DUPLICATE. The path -> (attack meaning, CWE, severity) knowledge is
 * ported from AgenticQA's DAST probe database
 * (AgenticQA/src/agenticqa/bounty/dast_scanner.py `_PROBE_PATHS`), the same
 * curated set our scanner uses to find these exposures in a target. Here we
 * invert it: recognize the same signatures in INBOUND agent traffic. It also
 * covers every entry in this repo's own SENSITIVE_PROBE_PATHS so the two agree.
 * Keep in sync with the AgenticQA source when it grows.
 *
 * Reference data only. No PII, deterministic.
 */

export type ProbeSeverity = "low" | "medium" | "high" | "critical";
export type ProbeCategory = "secrets-exposure" | "debug-exposure" | "admin-surface" | "api-surface" | "ssrf" | "config-exposure" | "recon";

export interface ProbeSignature {
  /** Path prefix that identifies the probe (matched case-insensitively, as an
   *  exact path or a `${prefix}` / `${prefix}/...` / `${prefix}....` boundary). */
  prefix: string;
  label: string;
  cwe: string;
  severity: ProbeSeverity;
  category: ProbeCategory;
}

/** Ordered most-specific-first so /actuator/env wins over /actuator. */
export const PROBE_SIGNATURES: readonly ProbeSignature[] = [
  // Cloud metadata -> SSRF / credential theft (the highest-signal probe).
  { prefix: "/latest/meta-data", label: "Cloud metadata endpoint (SSRF / credential theft)", cwe: "CWE-918", severity: "critical", category: "ssrf" },
  // Secrets / source exposure.
  { prefix: "/.env", label: "Environment file exposure (secrets)", cwe: "CWE-200", severity: "critical", category: "secrets-exposure" },
  { prefix: "/.git", label: "Git repository exposure (source + secrets)", cwe: "CWE-200", severity: "critical", category: "secrets-exposure" },
  { prefix: "/.aws", label: "AWS credentials directory probe", cwe: "CWE-200", severity: "critical", category: "secrets-exposure" },
  { prefix: "/.ssh", label: "SSH key directory probe", cwe: "CWE-200", severity: "critical", category: "secrets-exposure" },
  // Framework debug / actuator exposure.
  { prefix: "/actuator/env", label: "Spring Actuator environment variables exposed", cwe: "CWE-200", severity: "critical", category: "debug-exposure" },
  { prefix: "/actuator", label: "Spring Boot Actuator exposed", cwe: "CWE-200", severity: "high", category: "debug-exposure" },
  { prefix: "/phpinfo.php", label: "PHP info page exposure", cwe: "CWE-200", severity: "high", category: "debug-exposure" },
  { prefix: "/elmah.axd", label: "ELMAH error log exposed (ASP.NET)", cwe: "CWE-200", severity: "high", category: "debug-exposure" },
  { prefix: "/server-status", label: "Apache server-status exposed", cwe: "CWE-200", severity: "medium", category: "debug-exposure" },
  { prefix: "/server-info", label: "Apache server-info exposed", cwe: "CWE-200", severity: "medium", category: "debug-exposure" },
  { prefix: "/debug", label: "Debug endpoint probe", cwe: "CWE-215", severity: "high", category: "debug-exposure" },
  { prefix: "/console", label: "Web console / debug shell probe", cwe: "CWE-215", severity: "high", category: "debug-exposure" },
  // Config / backup exposure.
  { prefix: "/config.json", label: "Config file exposure", cwe: "CWE-200", severity: "high", category: "config-exposure" },
  { prefix: "/config", label: "Config path probe", cwe: "CWE-200", severity: "medium", category: "config-exposure" },
  { prefix: "/backup", label: "Backup file probe", cwe: "CWE-530", severity: "high", category: "config-exposure" },
  { prefix: "/vendor", label: "Dependency directory probe", cwe: "CWE-200", severity: "low", category: "recon" },
  // Admin surfaces.
  { prefix: "/wp-login.php", label: "WordPress login (credential attack surface)", cwe: "CWE-200", severity: "medium", category: "admin-surface" },
  { prefix: "/wp-admin", label: "WordPress admin panel probe", cwe: "CWE-200", severity: "medium", category: "admin-surface" },
  { prefix: "/xmlrpc.php", label: "WordPress XML-RPC (amplification / brute force)", cwe: "CWE-200", severity: "medium", category: "admin-surface" },
  { prefix: "/phpmyadmin", label: "phpMyAdmin database console probe", cwe: "CWE-200", severity: "high", category: "admin-surface" },
  { prefix: "/administrator", label: "Admin console probe", cwe: "CWE-200", severity: "medium", category: "admin-surface" },
  { prefix: "/admin", label: "Admin surface probe", cwe: "CWE-200", severity: "medium", category: "admin-surface" },
  // API surface disclosure.
  { prefix: "/swagger.json", label: "Swagger/OpenAPI spec exposure", cwe: "CWE-200", severity: "medium", category: "api-surface" },
  { prefix: "/openapi.json", label: "OpenAPI spec exposure", cwe: "CWE-200", severity: "medium", category: "api-surface" },
  { prefix: "/graphql", label: "GraphQL endpoint (introspection) probe", cwe: "CWE-200", severity: "medium", category: "api-surface" },
];

const SEVERITY_RANK: Record<ProbeSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Match one path to its most-specific probe signature, or null. */
export function matchProbePath(path: string): ProbeSignature | null {
  const p = (path || "").toLowerCase().split("?")[0];
  for (const sig of PROBE_SIGNATURES) {
    const s = sig.prefix;
    if (p === s || p.startsWith(`${s}/`) || p.startsWith(`${s}.`)) return sig;
  }
  return null;
}

export interface ProbeIntelEntry {
  label: string;
  cwe: string;
  severity: ProbeSeverity;
  category: ProbeCategory;
  count: number;
}

/**
 * Aggregate probe intelligence across many paths: which named attacks agents are
 * scanning for, with counts, ranked by severity then frequency. Deterministic.
 */
export function summarizeProbeIntel(paths: readonly string[]): ProbeIntelEntry[] {
  const byLabel = new Map<string, ProbeIntelEntry>();
  for (const path of paths) {
    const sig = matchProbePath(path);
    if (!sig) continue;
    const existing = byLabel.get(sig.label);
    if (existing) existing.count += 1;
    else byLabel.set(sig.label, { label: sig.label, cwe: sig.cwe, severity: sig.severity, category: sig.category, count: 1 });
  }
  return Array.from(byLabel.values()).sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count || a.label.localeCompare(b.label),
  );
}
