/**
 * Deterministic recommendation engine: pure rules over a target's SystemProfile
 * + open findings. No I/O, no tokens, fully reproducible, so every proposal is
 * traceable to a rule + evidence and is safe to drive gated execution. LLM-based
 * synthesis of novel recommendations is a deliberate later tier (opt-in, clearly
 * labeled, never auto-executed) layered ON TOP of this deterministic base.
 */
import type { SystemProfile } from "../profile/types";
import type { ScanFindingRow } from "../store";
import type { AutomationRecommendation, RecPriority } from "./types";

export interface RecommendInput {
  platform: string;
  profile: SystemProfile | null;
  /** Open findings for the platform (any severity). */
  findings: ScanFindingRow[];
  /** How many scans have run (0 = never scanned). */
  scanCount: number;
}

const SEV_RANK: Record<RecPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const maxPriority = (a: RecPriority, b: RecPriority): RecPriority => (SEV_RANK[a] <= SEV_RANK[b] ? a : b);

/** Integration name -> a tailored automation opportunity. */
export const INTEGRATION_PLAYS: Record<string, { title: string; action: string }> = {
  Salesforce: { title: "Automate CRM lead sync and enrichment", action: "Connect the CRM and run a gated agent task to sync + enrich new leads on a schedule." },
  HubSpot: { title: "Automate CRM lead sync and enrichment", action: "Connect the CRM and run a gated agent task to sync + enrich new leads on a schedule." },
  Stripe: { title: "Automate payment reconciliation and failed-charge alerts", action: "Schedule a gated job to reconcile charges and alert on failed/disputed payments." },
  Twilio: { title: "Automate SMS notifications and reminders", action: "Drive appointment/status SMS through a gated agent task with opt-out respected." },
  "Email provider": { title: "Automate transactional email flows", action: "Move ad-hoc sends behind a gated, audited email automation." },
  QuickBooks: { title: "Automate accounting sync", action: "Schedule a gated job to push invoices/journal entries and reconcile." },
  Plaid: { title: "Automate financial-data refresh", action: "Schedule a gated job to refresh linked accounts and surface anomalies." },
};

export function recommendAutomations(input: RecommendInput): AutomationRecommendation[] {
  const recs = new Map<string, AutomationRecommendation>();
  const add = (r: AutomationRecommendation) => {
    const existing = recs.get(r.key);
    // Keep the higher-priority instance if a key is produced twice.
    if (!existing || SEV_RANK[r.priority] < SEV_RANK[existing.priority]) recs.set(r.key, r);
  };

  const open = input.findings;
  const sec = open.filter((f) => f.category === "security");
  const has = (pred: (f: ScanFindingRow) => boolean) => open.filter(pred);

  // --- Security remediation rules (each maps a finding class to a fix) ---
  const headerFindings = has((f) => /Missing (Content-Security-Policy|Strict-Transport-Security|clickjacking|X-Content-Type-Options)/i.test(f.title));
  if (headerFindings.length > 0) {
    add({ key: "security_remediation:headers", category: "security_remediation", priority: "high",
      title: "Add a security-headers middleware",
      rationale: `${headerFindings.length} response(s) are missing baseline security headers (CSP / HSTS / X-Frame-Options / nosniff).`,
      suggestedAction: "Set the missing headers globally in middleware, then re-scan to confirm.",
      source: "finding:security", evidence: { count: headerFindings.length } });
  }
  const cookieFindings = has((f) => /Insecure Set-Cookie/i.test(f.title));
  if (cookieFindings.length > 0) {
    add({ key: "security_remediation:cookies", category: "security_remediation", priority: "high",
      title: "Harden session cookie flags",
      rationale: `${cookieFindings.length} cookie(s) are set without HttpOnly/Secure/SameSite.`,
      suggestedAction: "Set HttpOnly, Secure, and SameSite on session cookies.",
      source: "finding:security", evidence: { count: cookieFindings.length } });
  }
  const secrets = has((f) => /Hardcoded secret/i.test(f.title));
  if (secrets.length > 0) {
    add({ key: "security_remediation:secrets", category: "security_remediation", priority: "critical",
      title: "Rotate exposed credentials and move to a secret manager",
      rationale: `${secrets.length} committed credential(s) detected. Treat each as already leaked.`,
      suggestedAction: "Rotate the keys immediately, remove from source, load from env / a secret manager.",
      source: "finding:security", evidence: { count: secrets.length } });
  }
  const authGaps = has((f) => /served content without auth|requires auth|bounced to login|Authenticated request/i.test(f.title));
  if (authGaps.length > 0) {
    add({ key: "security_remediation:auth", category: "security_remediation", priority: "critical",
      title: "Enforce authentication on protected routes",
      rationale: `${authGaps.length} access-control gap(s): protected content reachable or auth not honored.`,
      suggestedAction: "Gate the routes in middleware so unauthenticated requests redirect/401.",
      source: "finding:security", evidence: { count: authGaps.length } });
  }
  const cors = has((f) => /CORS wildcard with credentials/i.test(f.title));
  if (cors.length > 0) {
    add({ key: "security_remediation:cors", category: "security_remediation", priority: "critical",
      title: "Restrict CORS to an allowlist",
      rationale: "A credentialed endpoint allows any origin (ACAO: * with credentials).",
      suggestedAction: "Echo a specific allowed origin instead of '*' on credentialed endpoints.",
      source: "finding:security", evidence: { count: cors.length } });
  }
  const silent = has((f) => /fetch result used without an ok\/status check/i.test(f.title));
  if (silent.length > 0) {
    add({ key: "quality:fetch_guards", category: "quality", priority: "medium",
      title: "Add response ok-checks to client fetches",
      rationale: `${silent.length} fetch(es) consume the body without an ok/status guard (silent blank-page risk).`,
      suggestedAction: "Route fetches through a helper that throws on non-2xx so errors surface.",
      source: "finding:bug", evidence: { count: silent.length } });
  }

  // Catch-all: any open critical/high security finding not covered above.
  const coveredKeys = new Set(["headers", "cookies", "secrets", "auth", "cors"]);
  void coveredKeys;
  const criticalHigh = sec.filter((f) => f.severity === "critical" || f.severity === "high");
  if (criticalHigh.length > 0 && !recs.has("security_remediation:headers") && !recs.has("security_remediation:secrets") && !recs.has("security_remediation:auth")) {
    const pr: RecPriority = criticalHigh.some((f) => f.severity === "critical") ? "critical" : "high";
    add({ key: "security_remediation:open_findings", category: "security_remediation", priority: pr,
      title: `Remediate ${criticalHigh.length} open security finding(s)`,
      rationale: "Open critical/high security findings remain that are not covered by a specific automation.",
      suggestedAction: "Triage in the platform-scans console and remediate by severity.",
      source: "finding:security", evidence: { count: criticalHigh.length } });
  }

  // --- Integration automation opportunities (from the profile) ---
  for (const integ of input.profile?.integrations ?? []) {
    const play = INTEGRATION_PLAYS[integ.name];
    const key = `integration:${integ.name.toLowerCase().replace(/\W+/g, "_")}`;
    add(play
      ? { key, category: "integration_automation", priority: "medium", title: play.title,
          rationale: `${integ.name} (${integ.category}) is integrated; a gated agent can automate this workflow.`,
          suggestedAction: play.action, source: `profile:integration:${integ.name}`, evidence: { package: integ.package, category: integ.category } }
      : { key, category: "integration_automation", priority: "low", title: `Automate ${integ.name} workflows`,
          rationale: `${integ.name} (${integ.category}) is integrated; consider a gated automation for its repetitive tasks.`,
          suggestedAction: `Identify a repeatable ${integ.name} task and run it as a gated, audited agent action.`,
          source: `profile:integration:${integ.name}`, evidence: { package: integ.package, category: integ.category } });
  }

  // --- Quality + operational posture (from the profile + scan history) ---
  if (input.profile && input.profile.surface.tests === 0 && input.profile.surface.totalFiles > 0) {
    add({ key: "quality:ci_tests", category: "quality", priority: "high",
      title: "Add a CI test gate",
      rationale: "No test files were discovered; regressions can ship unguarded.",
      suggestedAction: "Add a test suite and gate merges on it in CI.",
      source: "profile:surface", evidence: { totalFiles: input.profile.surface.totalFiles } });
  }
  if (input.profile && input.profile.surface.migrations > 0) {
    add({ key: "security_remediation:rls", category: "security_remediation", priority: "medium",
      title: "Verify row-level-security coverage on all tables",
      rationale: `${input.profile.surface.migrations} migration(s) define the schema; confirm every table enforces tenant isolation.`,
      suggestedAction: "Run an RLS verification and add policies to any unprotected table.",
      source: "profile:surface", evidence: { migrations: input.profile.surface.migrations } });
  }
  add(input.scanCount === 0
    ? { key: "operational:scan_cadence", category: "operational", priority: "high",
        title: "Run an initial security scan",
        rationale: "No scan has been run for this platform yet.",
        suggestedAction: "Run the platform scan, then schedule it on a recurring cadence.",
        source: "posture", evidence: { scanCount: 0 } }
    : { key: "operational:scan_cadence", category: "operational", priority: "low",
        title: "Schedule recurring scans",
        rationale: `${input.scanCount} scan(s) have run; a recurring cadence catches regressions continuously.`,
        suggestedAction: "Schedule the scan so new findings auto-surface and auto-resolve on fix.",
        source: "posture", evidence: { scanCount: input.scanCount } });
  add({ key: "operational:sast", category: "operational", priority: "medium",
    title: "Wire a dataflow SAST (Semgrep) into CI",
    rationale: "Regex scanning cannot precisely cover taint classes (SQLi, SSRF, path traversal); a dataflow SAST can.",
    suggestedAction: "Run Semgrep in CI and ingest its SARIF into the scanner pipeline.",
    source: "posture", evidence: {} });

  // Sort by priority then category for a stable, reviewable order.
  return Array.from(recs.values()).sort(
    (a, b) => SEV_RANK[a.priority] - SEV_RANK[b.priority] || a.category.localeCompare(b.category) || a.key.localeCompare(b.key),
  );
}

export { maxPriority };
