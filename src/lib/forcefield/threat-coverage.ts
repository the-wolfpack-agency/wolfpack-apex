/**
 * Threat-coverage matrix: the single, honest map of which threats this
 * agent-protection stack detects, on which lens, and where the gaps are.
 *
 * WHY IT EXISTS. Coverage was scattered across five unconnected detectors with
 * no way to answer "what do we actually cover, and what could catch us off
 * guard?" A credible, client-ready tool proves its coverage AND names its gaps
 * rather than implying completeness. So this maps the CWE Top 25 plus the
 * agent/LLM-specific classes to the lens covering each, with an explicit status.
 *
 * TWO HONESTY RAILS, ENCODED:
 *   1. Many CWE Top 25 entries are memory-safety / code-level and are NOT
 *      observable in inbound agent traffic - they belong to the static/SAST
 *      lens, not this one. They are marked "not-agent-observable" rather than
 *      quietly claimed or quietly dropped.
 *   2. Every real gap (prompt injection on live traffic, insecure output, open
 *      redirect, inbound IDOR/authz, runaway-loop exhaustion) is marked "gap",
 *      so the matrix is a to-do list, not a trophy.
 *
 * Pure + deterministic. Reuses the CWE strings the probe lens already emits
 * (agent-probe-signatures) and the OWASP-LLM enum the red-team already uses
 * (ai-redteam/types RedTeamCategory), and a parity test keeps this synced to
 * those real detectors so it can never drift into an overclaim.
 */

/** Where a threat is (or is not) detected. */
export type DetectionLens =
  | "probe-path" // agent-probe-signatures: what an agent scans for
  | "payload" // forcefield-payload (ogiam-site): what an agent sends
  | "agent-behavior" // agent-behavior: how an agent acts (rate, decoys, violations)
  | "tool-composition" // agent-tool-composition: what an agent is equipped to do
  | "web-classifier" // forcefield-web/classify: UA + decoy classification
  | "red-team-offline"; // ai-redteam: exercised against the gate, not live traffic

export type CoverageStatus =
  | "covered" // a live lens detects it
  | "partial" // detected indirectly / only one facet
  | "gap" // agent-observable but NOT detected yet
  | "not-agent-observable"; // real CWE, but not expressible in inbound agent traffic (static/SAST domain)

export type ThreatFamily = "cwe-top-25" | "agent-llm" | "exposure-recon";

export interface ThreatEntry {
  /** CWE-nnn or an OWASP-LLM id. */
  id: string;
  name: string;
  family: ThreatFamily;
  status: CoverageStatus;
  /** Lenses that detect it (empty for gap / not-agent-observable). */
  lenses: DetectionLens[];
  note: string;
}

export const THREAT_COVERAGE: readonly ThreatEntry[] = [
  // ── CWE Top 25: web / agent-observable (covered or partial) ──────────────
  { id: "CWE-79", name: "Cross-site scripting (XSS)", family: "cwe-top-25", status: "covered", lenses: ["payload"], note: "XSS payloads matched by the evasion-aware payload inspector." },
  { id: "CWE-89", name: "SQL injection", family: "cwe-top-25", status: "covered", lenses: ["payload"], note: "SQLi payloads matched after normalization (double-decode, fold)." },
  { id: "CWE-78", name: "OS command injection", family: "cwe-top-25", status: "covered", lenses: ["payload", "probe-path"], note: "Command-injection payloads + /cgi-bin Shellshock probes." },
  { id: "CWE-77", name: "Command injection", family: "cwe-top-25", status: "covered", lenses: ["payload"], note: "Same detector family as CWE-78." },
  { id: "CWE-22", name: "Path traversal", family: "cwe-top-25", status: "covered", lenses: ["probe-path", "payload"], note: "/etc/passwd probes + traversal payloads." },
  { id: "CWE-918", name: "Server-side request forgery (SSRF)", family: "cwe-top-25", status: "partial", lenses: ["probe-path"], note: "Cloud-metadata path probe is caught; SSRF via request params is not yet inspected at the payload layer (gap tracked)." },
  { id: "CWE-502", name: "Deserialization of untrusted data", family: "cwe-top-25", status: "covered", lenses: ["probe-path"], note: "JBoss JMXInvoker / WebLogic WLS-WSAT RCE-deserialization probes." },
  { id: "CWE-94", name: "Code injection", family: "cwe-top-25", status: "covered", lenses: ["probe-path"], note: "PHPUnit eval-stdin RCE probe." },
  { id: "CWE-434", name: "Unrestricted file upload", family: "cwe-top-25", status: "gap", lenses: [], note: "No inbound upload-abuse detector yet." },
  { id: "CWE-862", name: "Missing authorization", family: "cwe-top-25", status: "gap", lenses: [], note: "Detected only outbound (pentest scanner); no inbound agent-authz signal." },
  { id: "CWE-863", name: "Incorrect authorization", family: "cwe-top-25", status: "gap", lenses: [], note: "Outbound-scan only; no inbound signal." },
  { id: "CWE-306", name: "Missing authentication for critical function", family: "cwe-top-25", status: "gap", lenses: [], note: "Outbound-scan only; no inbound signal." },
  { id: "CWE-287", name: "Improper authentication", family: "cwe-top-25", status: "partial", lenses: ["agent-behavior", "web-classifier"], note: "Spoofed-identity / forged good-bot badge is caught; general auth bypass is outbound-scan only." },
  { id: "CWE-798", name: "Use of hard-coded credentials", family: "cwe-top-25", status: "partial", lenses: ["probe-path"], note: "Credential-FILE probing (CWE-522: id_rsa/.npmrc/.netrc) is the inbound proxy; hardcoded-in-code is the static-scan domain." },
  { id: "CWE-352", name: "Cross-site request forgery (CSRF)", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Browser-trust exploit; not expressible as autonomous-agent traffic." },
  // ── CWE Top 25: memory-safety / code-level (static/SAST domain, not us) ───
  { id: "CWE-787", name: "Out-of-bounds write", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Memory-safety; static/SAST lens (AgenticQA), not inbound agent traffic." },
  { id: "CWE-125", name: "Out-of-bounds read", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Memory-safety; static/SAST domain." },
  { id: "CWE-416", name: "Use after free", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Memory-safety; static/SAST domain." },
  { id: "CWE-476", name: "NULL pointer dereference", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Code-level; static/SAST domain." },
  { id: "CWE-190", name: "Integer overflow", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Code-level; static/SAST domain." },
  { id: "CWE-119", name: "Improper restriction of memory buffer", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Memory-safety; static/SAST domain." },
  { id: "CWE-362", name: "Race condition", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Concurrency; static/SAST domain." },
  { id: "CWE-20", name: "Improper input validation", family: "cwe-top-25", status: "partial", lenses: ["payload", "probe-path"], note: "The concrete injection facets (79/89/78/22) are caught; the broad class is a code-level concern." },
  { id: "CWE-269", name: "Improper privilege management", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Code-level authz design; static/SAST domain." },
  { id: "CWE-276", name: "Incorrect default permissions", family: "cwe-top-25", status: "not-agent-observable", lenses: [], note: "Config/code-level; static/SAST domain." },

  // ── Exposure / recon (detected by the probe lens; not in the Top 25) ─────
  { id: "CWE-200", name: "Exposure of sensitive information", family: "exposure-recon", status: "covered", lenses: ["probe-path"], note: "The dominant probe signal: .env / .git / actuator / config / api-spec disclosure probes." },
  { id: "CWE-522", name: "Insufficiently protected credentials", family: "exposure-recon", status: "covered", lenses: ["probe-path"], note: "Credential-file probes: id_rsa, .npmrc, .netrc, .dockercfg, wp-config.php." },
  { id: "CWE-527", name: "Exposure of version-control directory", family: "exposure-recon", status: "covered", lenses: ["probe-path"], note: "VCS-directory probes: .svn, .hg, .bzr, WEB-INF." },
  { id: "CWE-530", name: "Exposure of backup file", family: "exposure-recon", status: "covered", lenses: ["probe-path"], note: "Backup-file probes." },
  { id: "CWE-215", name: "Insertion of sensitive info into debug output", family: "exposure-recon", status: "covered", lenses: ["probe-path"], note: "/debug and /console probes." },

  // ── Agent / LLM-specific classes ─────────────────────────────────────────
  { id: "CWE-1427", name: "Prompt injection (OWASP LLM01)", family: "agent-llm", status: "gap", lenses: ["red-team-offline"], note: "Exercised offline against the gate (LLM01); NO live inbound prompt-injection detector yet. Highest-priority agent gap." },
  { id: "LLM02", name: "Insecure output handling", family: "agent-llm", status: "gap", lenses: [], note: "Not detected; no model-output scanning." },
  { id: "LLM06", name: "Sensitive information disclosure", family: "agent-llm", status: "partial", lenses: ["tool-composition", "probe-path"], note: "data-exfil tool intent + secrets-exposure probing; no output scanning." },
  { id: "LLM07", name: "Insecure tool / plugin design", family: "agent-llm", status: "covered", lenses: ["tool-composition"], note: "unauthorized-access / credential-abuse tool intents from the toolset." },
  { id: "LLM08", name: "Excessive agency", family: "agent-llm", status: "covered", lenses: ["tool-composition"], note: "MALICIOUS_COMBINATIONS intents (data_theft, intrusion_attempt) from the equipped tools." },
  { id: "CWE-290", name: "Authentication bypass by spoofing (impersonation)", family: "agent-llm", status: "covered", lenses: ["agent-behavior", "web-classifier"], note: "identified_agent + forged good-bot badge detection." },
  { id: "CWE-693", name: "Protection mechanism failure (evasion)", family: "agent-llm", status: "covered", lenses: ["agent-behavior", "tool-composition"], note: "deliberate_violation (reads robots then violates) + evasion tool intent." },
  { id: "CWE-799", name: "Improper control of interaction frequency", family: "agent-llm", status: "covered", lenses: ["agent-behavior"], note: "form_too_fast / high_rate / form_spammer signals." },
  { id: "CWE-770", name: "Resource exhaustion", family: "agent-llm", status: "covered", lenses: ["agent-behavior"], note: "high_rate plus runaway-loop repetition detection (one endpoint hammered in a session -> the runaway_loop signal)." },
  { id: "CWE-601", name: "Open redirect", family: "agent-llm", status: "gap", lenses: [], note: "Only a server-side returnTo guard; not an inbound detection signal." },
  { id: "CWE-639", name: "Insecure direct object reference (IDOR)", family: "agent-llm", status: "covered", lenses: ["agent-behavior"], note: "Sequential-ID enumeration (walking /users/1, /2, /3) is detected inbound as the id_enumeration behavior signal." },
];

export interface CoverageSummary {
  total: number;
  covered: number;
  partial: number;
  gap: number;
  notAgentObservable: number;
  /** Of the AGENT-OBSERVABLE threats (excludes not-agent-observable), the share
   *  detected at least partially. The honest headline metric. */
  observableTotal: number;
  observableDetected: number;
  gaps: ThreatEntry[];
}

export function coverageSummary(entries: readonly ThreatEntry[] = THREAT_COVERAGE): CoverageSummary {
  const covered = entries.filter((e) => e.status === "covered").length;
  const partial = entries.filter((e) => e.status === "partial").length;
  const gap = entries.filter((e) => e.status === "gap").length;
  const notAgentObservable = entries.filter((e) => e.status === "not-agent-observable").length;
  const observableTotal = entries.length - notAgentObservable;
  const observableDetected = covered + partial;
  return {
    total: entries.length,
    covered,
    partial,
    gap,
    notAgentObservable,
    observableTotal,
    observableDetected,
    gaps: entries.filter((e) => e.status === "gap"),
  };
}
