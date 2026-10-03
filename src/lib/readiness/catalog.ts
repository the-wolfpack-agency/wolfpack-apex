/**
 * Production-readiness engine - the tool catalog.
 *
 * Each tool declares how to scan the repo for its signals and which criteria
 * grade them. Criteria common to every production surface (DB-layer tests, an
 * E2E that gates on PRs, DB-enforced tenant isolation, analytics + hash-chained
 * audit) are defined ONCE here and reused by every tool (DRY). Only the
 * tool-specific criteria are written per tool.
 *
 * Current statuses are derived from static facts where a reliable check exists
 * (kind:"auto"); the handful that need runtime or judgment are kind:"attested"
 * and read a centrally-maintained fact in collectSignals, shown honestly and
 * flipped in one place when the gap is closed. This file is the living backlog:
 * a criterion moving gap -> partial -> ready is the tool getting closer to done.
 */
import type { ReadinessCriterion, ToolSignals, ToolSpec, RepoReader } from "./types";
import {
  anyFileMatches,
  dbTestCount,
  fileMatches,
  specGatesOnPR,
  workflowTexts,
} from "./scan";

// ---- signal accessors (null-safe) -----------------------------------------
const num = (s: ToolSignals, k: string): number => (typeof s[k] === "number" ? (s[k] as number) : 0);
const bool = (s: ToolSignals, k: string): boolean => s[k] === true;

/** The repo-wide predicate guardrail: a build-failing scan that every
 *  workspace-scoped query carries its workspace_id predicate. Its presence is
 *  what makes app-side isolation an ENFORCED control, not a hope. */
const TENANT_GUARDRAIL = "src/lib/db/__tests__/tenant-isolation-global.test.ts";

/**
 * Isolation signals for one tool's primary workspace-scoped table. Reflects the
 * repo's DOCUMENTED model (docs/tenant-isolation.md): the enforced boundary today
 * is the app-side workspace_id predicate backed by TENANT_GUARDRAIL (=> partial),
 * and DB-level session-var RLS (a current_setting('app.workspace_id') policy) is
 * the defense-in-depth goal (=> ready). A table with no workspace_id is unscoped
 * (=> gap). Honest, not binary.
 */
/** "skip-green" is only a problem when the spec can skip IN CI. A spec whose skip
 *  is guarded by a CI check (skips locally, FAILS in CI on misconfig) genuinely
 *  gates a PR, so it is NOT skip-green. Shared by every tool (DRY). */
function e2eSkipsGreen(reader: RepoReader, specPath: string): boolean {
  return fileMatches(reader, specPath, /test\.skip\(/) && !fileMatches(reader, specPath, /process\.env\.CI/);
}

function isolationSignals(reader: RepoReader, table: string): { isolationDbEnforced: boolean; isolationGuarded: boolean } {
  const migrations = ["src/db/migrations"];
  const hasWorkspaceId = anyFileMatches(reader, migrations, new RegExp(`${table}[\\s\\S]*workspace_id`, "i"));
  const hasRealRls = anyFileMatches(reader, migrations, new RegExp(`${table}[\\s\\S]*current_setting\\('app\\.workspace_id'`, "i"));
  return { isolationDbEnforced: hasRealRls, isolationGuarded: hasWorkspaceId && reader.exists(TENANT_GUARDRAIL) };
}

// ---- reusable criteria shared by every tool -------------------------------
const dbTestsCriterion = (): ReadinessCriterion => ({
  id: "db-tests",
  dimension: "tests",
  kind: "auto",
  title: "DB-layer tests exercise real persistence and isolation",
  rationale:
    "A mocked query() only proves we sent the SQL we intended, never that it is correct, isolated, or that the migration/RLS behaves. This is the layer the repo's own db-contract guard exists for.",
  status: (s) => {
    const n = num(s, "dbTestCount");
    return n >= 2 ? "ready" : n === 1 ? "partial" : "gap";
  },
  evidence: (s) => `${num(s, "dbTestCount")} *.db.test.ts covering this surface`,
});

const e2eGatesCriterion = (): ReadinessCriterion => ({
  id: "e2e-gates-on-pr",
  dimension: "tests",
  kind: "auto",
  title: "A real-model E2E gates on PRs (not skip-green, not post-merge-only)",
  rationale:
    "An E2E that test.skip()s when creds are absent, or only runs as a soft post-merge step, reports green while the live surface is broken. A regression then ships on a green PR.",
  status: (s) => {
    const gates = bool(s, "e2eGatesOnPR");
    const skips = bool(s, "e2eSkipsGreen");
    return gates && !skips ? "ready" : gates ? "partial" : "gap";
  },
  evidence: (s) => `gatesOnPR=${bool(s, "e2eGatesOnPR")} skipsGreenWithoutCreds=${bool(s, "e2eSkipsGreen")}`,
});

const isolationCriterion = (): ReadinessCriterion => ({
  id: "isolation-db-enforced",
  dimension: "isolation",
  kind: "auto",
  title: "Tenant isolation: predicate-guarded now, DB-level RLS as defense-in-depth",
  rationale:
    "The enforced boundary today is the app-side workspace_id predicate backed by the repo-wide build-failing guardrail (docs/tenant-isolation.md) - materially stronger than app-code alone, hence partial. DB-level session-var RLS (a current_setting policy) adds defense-in-depth so a forgotten predicate still cannot leak - that is ready. A table with no workspace_id is unscoped - gap.",
  status: (s) => (bool(s, "isolationDbEnforced") ? "ready" : bool(s, "isolationGuarded") ? "partial" : "gap"),
  evidence: (s) =>
    bool(s, "isolationDbEnforced")
      ? "DB-level RLS keyed on the workspace GUC (defense-in-depth)"
      : bool(s, "isolationGuarded")
        ? "workspace_id + repo-wide predicate guardrail (enforced app-side); DB-level RLS pending"
        : "no workspace_id / not covered by the predicate guardrail",
});

const observabilityCriterion = (): ReadinessCriterion => ({
  id: "observability",
  dimension: "observability",
  kind: "auto",
  title: "Actions emit analytics and a hash-chained audit record",
  rationale:
    "Without a durable, tamper-evident record there is no learning loop and no forensics when an agent action is disputed.",
  status: (s) => {
    const a = bool(s, "emitsAnalytics");
    const h = bool(s, "hashChainedAudit");
    return a && h ? "ready" : a || h ? "partial" : "gap";
  },
  evidence: (s) => `analytics=${bool(s, "emitsAnalytics")} hashChainedAudit=${bool(s, "hashChainedAudit")}`,
});

// ===========================================================================
// Tool: the code factory  (/admin/ai-code)
// ===========================================================================
const AI_CODE_ROUTES = ["src/app/api/admin/ai-code"];
const AI_CODE_LIBS = ["src/lib/ai-code", "src/lib/ai"];
const AI_CODE_E2E = "tests/e2e/ai-code-factory-live.spec.ts";
const DEEP_SCAN = "src/lib/ai-code/deep-scan.ts";

const aiCode: ToolSpec = {
  id: "ai-code",
  label: "Code Factory",
  surface: "/admin/ai-code",
  collectSignals(reader: RepoReader): ToolSignals {
    const wf = workflowTexts(reader);
    // ai-code DB tests live under src/db/__tests__ (ai-code-reviews.db.test.ts)
    // plus any co-located under its lib/routes.
    const aiCodeDbTests =
      reader.listFiles("src/db/__tests__", ".db.test.ts").filter((f) => /ai.?code/i.test(f)).length +
      dbTestCount(reader, [...AI_CODE_ROUTES, ...AI_CODE_LIBS]);
    return {
      dbTestCount: aiCodeDbTests,
      e2eGatesOnPR: specGatesOnPR(wf, AI_CODE_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, AI_CODE_E2E),
      emitsAnalytics: anyFileMatches(reader, AI_CODE_ROUTES, /trackEvent/),
      ...isolationSignals(reader, "instinct_ai_code_reviews"),
      defaultWorkspaceCoalesce: anyFileMatches(reader, AI_CODE_ROUTES, /\?\?\s*"default"/),
      // deep static scan covers edits when it reads full changed files, not only new files.
      deepScanCoversEdits:
        fileMatches(reader, DEEP_SCAN, /changedFiles|changedLines|modifiedLines|editedFiles|addedLines/),
      // a transient audit-write never 500s a completed run: no bare `await recordAudit(`
      // in the routes (all post-hoc writes go through recordAuditNonFatal).
      auditCallsGuarded: !anyFileMatches(reader, AI_CODE_ROUTES, /await recordAudit\(/),
      // escalation/degrade surfaces on the response (degraded flag), so a kept
      // cheaper answer is never silent - the router tags it, not just analytics.
      noSilentTierDegrade: fileMatches(reader, "src/lib/ai/router.ts", /degraded: true/),
      // --- attested (centrally maintained; flip when closed) ---
      // the pipeline run writes an ai_code.pipeline_run entry via recordAuditNonFatal
      // -> recordAudit -> the hash-chained audit log (same as every other tool here).
      hashChainedAudit: anyFileMatches(reader, AI_CODE_ROUTES, /recordAudit/),
      retentionFailClosed: false, // AI_ZERO_RETENTION unset => sensitive egress is non-blocking
    };
  },
  criteria: [
    dbTestsCriterion(),
    e2eGatesCriterion(),
    isolationCriterion(),
    observabilityCriterion(),
    {
      id: "no-default-workspace-coalesce",
      dimension: "isolation",
      kind: "auto",
      title: "A missing workspace never coalesces into a shared bucket",
      rationale:
        '`?? "default"` on workspaceId means a null workspace silently collapses multiple tenants into one shared bucket where they can read each other.',
      status: (s) => (bool(s, "defaultWorkspaceCoalesce") ? "gap" : "ready"),
      evidence: (s) =>
        bool(s, "defaultWorkspaceCoalesce")
          ? 'routes contain `?? "default"` on workspace id'
          : "no default-workspace coalescing in routes",
    },
    {
      id: "deep-scan-covers-edits",
      dimension: "correctness",
      kind: "auto",
      title: "The deep security scan covers edits, not just new files",
      rationale:
        "If deep-scan only reads new files, a secret or SSRF introduced via a modification hunk to an existing file evades the deepest detectors - the gate's core promise has a hole.",
      status: (s) => (bool(s, "deepScanCoversEdits") ? "ready" : "gap"),
      evidence: (s) =>
        bool(s, "deepScanCoversEdits") ? "scans changed/added lines" : "new-files-only (edits bypass deep scan)",
    },
    {
      id: "no-silent-model-degrade",
      dimension: "fail-closed",
      kind: "auto",
      title: 'Escalation never silently serves the cheap model ("routed up" is true)',
      rationale:
        "A premium-tier 404 degraded a tier down, and verify-escalation is wrapped in catch-and-keep-cheap. The flagship promise can fail invisibly - the exact failure the live dogfood exists to catch.",
      status: (s) => (bool(s, "noSilentTierDegrade") ? "ready" : "gap"),
      evidence: (s) =>
        bool(s, "noSilentTierDegrade") ? "degrade is surfaced, not silent" : "inline router path can keep the cheap answer silently",
    },
    {
      id: "retention-fail-closed",
      dimension: "config-safety",
      kind: "attested",
      title: "Sensitive requests fail closed when zero-retention is unconfigured",
      rationale:
        "If AI_ZERO_RETENTION_PROVIDERS is unset, PII/PHI requests egress to any provider (treated as non-blocking). A compliance blocker before handling real client data.",
      status: (s) => (bool(s, "retentionFailClosed") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "retentionFailClosed") ? "sensitive egress blocked when unconfigured" : "fail-open retention"),
    },
    {
      id: "audit-calls-guarded",
      dimension: "fail-closed",
      kind: "auto",
      title: "A transient audit-write failure never 500s a completed run",
      rationale:
        "Bare `await recordAudit(...)` after paid model work means a DB hiccup throws an unhandled 500 and the client loses a run that actually succeeded.",
      status: (s) => (bool(s, "auditCallsGuarded") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "auditCallsGuarded") ? "audit writes are guarded" : "bare recordAudit awaits present"),
    },
  ],
};

// ===========================================================================
// Tool: Forcefield Web  (/admin/site-analytics)
// ===========================================================================
const SA_ROUTES = ["src/app/api/admin/site-analytics", "src/app/api/site-analytics"];
const SA_LIB = "src/lib/site-analytics.ts";
const SA_E2E = "tests/e2e/site-analytics-agent-profile.spec.ts";

const siteAnalytics: ToolSpec = {
  id: "site-analytics",
  label: "Forcefield Web (agent-traffic observatory)",
  surface: "/admin/site-analytics",
  collectSignals(reader: RepoReader): ToolSignals {
    const wf = workflowTexts(reader);
    const migrations = ["src/db/migrations"];
    // The core events table (migration mentions site_analytics_events) must carry
    // workspace_id for any shared-DB isolation to be possible.
    const eventsHasSiteIndex = anyFileMatches(
      reader,
      migrations,
      /site_analytics_events[\s\S]*(props->>'site'|props->>'fp'|USING gin)/i,
    );
    // This surface's DB tests live in src/db/__tests__ (events/operator/triage/
    // reputation) plus any under its routes. Count only the ones that cover it.
    const saDbTests =
      reader
        .listFiles("src/db/__tests__", ".db.test.ts")
        .filter((p) => /site|operator|agent|triage|reputation|forcefield/i.test(p)).length +
      dbTestCount(reader, SA_ROUTES);
    return {
      dbTestCount: saDbTests,
      e2eGatesOnPR: specGatesOnPR(wf, SA_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, SA_E2E),
      emitsAnalytics: anyFileMatches(reader, SA_ROUTES, /trackEvent/),
      hashChainedAudit: anyFileMatches(reader, SA_ROUTES, /recordAudit/),
      ...isolationSignals(reader, "site_analytics_events"),
      perfIndexes: eventsHasSiteIndex,
      // promote route must use the operator's real surface, not a hardcoded host.
      promoteSurfaceCorrect: !anyFileMatches(reader, SA_ROUTES, /SURFACE\s*=\s*"ogiam\.com"/),
      // the truthfulness engineering (n/a vs 0, hostile vs flagged) is present.
      truthfulnessHonest: fileMatches(reader, SA_LIB, /collectsPageViews|hostileOperators/),
      // ingest rate limit is DURABLE when the route no longer keeps in-memory
      // per-lambda counters (it delegates to the DB-backed checkRateLimit).
      durableRateLimit: !anyFileMatches(reader, SA_ROUTES, /let windowCount|let windowStart/),
    };
  },
  criteria: [
    dbTestsCriterion(),
    e2eGatesCriterion(),
    isolationCriterion(),
    observabilityCriterion(),
    {
      id: "events-perf-indexes",
      dimension: "correctness",
      kind: "auto",
      title: "The events table is indexed for the queries it actually runs",
      rationale:
        "The hot rollups filter by props->>'site' and GROUP BY props->>'fp' over a growing table with no matching index: seq-scans + per-row JSONB parsing => slow loads and timeouts at volume.",
      status: (s) => (bool(s, "perfIndexes") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "perfIndexes") ? "site/fp JSONB index present" : "no index on the grouped JSONB fields"),
    },
    {
      id: "promote-surface-correct",
      dimension: "correctness",
      kind: "auto",
      title: "Promoting an operator records its real surface",
      rationale:
        'The promote route hardcodes SURFACE="ogiam.com", so an operator first seen on another property is filed under the wrong surface.',
      status: (s) => (bool(s, "promoteSurfaceCorrect") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "promoteSurfaceCorrect") ? "uses the operator's surface" : 'hardcoded SURFACE="ogiam.com"'),
    },
    {
      id: "truthfulness",
      dimension: "correctness",
      kind: "auto",
      title: "Metrics are honest: n/a vs measured-zero, hostile vs merely flagged",
      rationale:
        "An agent-defense board that inflates 'threats' or shows a fabricated 0 destroys trust. This surface's distinguishing strength is that it does neither.",
      status: (s) => (bool(s, "truthfulnessHonest") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "truthfulnessHonest") ? "n/a-vs-0 and hostile-vs-flagged separation present" : "not detected"),
    },
    {
      id: "durable-rate-limit",
      dimension: "fail-closed",
      kind: "auto",
      title: "Ingest rate limiting is durable, not per-lambda in-memory",
      rationale:
        "An in-memory, cold-start-reset limit means a leaked ingest token floods far past the stated cap and inflates cost.",
      status: (s) => (bool(s, "durableRateLimit") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "durableRateLimit") ? "durable store-backed limit" : "in-memory per-lambda limit"),
    },
  ],
};

/** Every tool under readiness tracking. Add a tool here to put it on the board. */
// ===========================================================================
// Tool: OGIAM Gate  (/admin/ogiam) - the deterministic agent-action plane
// ===========================================================================
const OGIAM_ROUTES = ["src/app/api/admin/ogiam", "src/app/api/agents"];
const OGIAM_LIBS = ["src/lib/ogiam"];
const OGIAM_E2E = "tests/e2e/ogiam-gate-client-journeys.spec.ts";

const ogiamGate: ToolSpec = {
  id: "ogiam-gate",
  label: "OGIAM Gate (agent action plane)",
  surface: "/admin/ogiam",
  collectSignals(reader: RepoReader): ToolSignals {
    const wf = workflowTexts(reader);
    const migrations = ["src/db/migrations"];
    return {
      dbTestCount: dbTestCount(reader, [...OGIAM_ROUTES, ...OGIAM_LIBS]),
      e2eGatesOnPR: specGatesOnPR(wf, OGIAM_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, OGIAM_E2E),
      emitsAnalytics: anyFileMatches(reader, OGIAM_ROUTES, /trackEvent/),
      // the ledger IS the hash-chained audit for agent actions.
      hashChainedAudit: anyFileMatches(reader, OGIAM_LIBS, /entry_hash|prev_hash|sha256/i),
      ...isolationSignals(reader, "ogiam_decisions"),
      // models advise, only POLICY authorizes: a pure decide() is the whole thesis.
      policyDecides: fileMatches(reader, "src/lib/ogiam/policy.ts", /export function decide/),
      // the ledger is hash-chained AND the rows are immutable (a DB trigger blocks UPDATE/DELETE).
      ledgerImmutable:
        anyFileMatches(reader, OGIAM_LIBS, /entry_hash|sha256/i) &&
        anyFileMatches(reader, migrations, /ogiam[\s\S]*immutab|immutab[\s\S]*ogiam/i),
    };
  },
  criteria: [
    dbTestsCriterion(),
    e2eGatesCriterion(),
    isolationCriterion(),
    observabilityCriterion(),
    {
      id: "deterministic-policy-decides",
      dimension: "correctness",
      kind: "auto",
      title: "A deterministic policy authorizes the action - the model only advises",
      rationale:
        "If a model could authorize an agent action, a prompt-injected agent could authorize itself. A pure decide() over signals is the control that makes the gate model-independent.",
      status: (s) => (bool(s, "policyDecides") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "policyDecides") ? "pure decide() over signals" : "no deterministic decide() found"),
    },
    {
      id: "ledger-hash-chained-immutable",
      dimension: "observability",
      kind: "auto",
      title: "The action ledger is hash-chained and DB-immutable",
      rationale:
        "A tamper-evident, append-only ledger is what makes a disputed agent action auditable. A chain without a DB immutability trigger can be rewritten in place.",
      status: (s) => (bool(s, "ledgerImmutable") ? "ready" : bool(s, "hashChainedAudit") ? "partial" : "gap"),
      evidence: (s) =>
        bool(s, "ledgerImmutable") ? "hash chain + immutability trigger" : bool(s, "hashChainedAudit") ? "hash chain, trigger not detected" : "no hash chain",
    },
  ],
};

// ===========================================================================
// Tool: Agent Approvals  (/admin/agents) - human-in-the-loop -> execute-as-owner
// ===========================================================================
const APPROVALS_ROUTES = ["src/app/api/admin/agents"];
const APPROVALS_LIBS = ["src/lib/agents/approvals"];
const APPROVALS_E2E = "tests/e2e/agent-approvals-journeys.spec.ts";

const agentApprovals: ToolSpec = {
  id: "agent-approvals",
  label: "Agent Approvals (human-in-the-loop)",
  surface: "/admin/agents",
  collectSignals(reader: RepoReader): ToolSignals {
    const wf = workflowTexts(reader);
    return {
      dbTestCount: dbTestCount(reader, [...APPROVALS_ROUTES, ...APPROVALS_LIBS]),
      e2eGatesOnPR: specGatesOnPR(wf, APPROVALS_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, APPROVALS_E2E),
      emitsAnalytics: anyFileMatches(reader, APPROVALS_ROUTES, /trackEvent/),
      hashChainedAudit: anyFileMatches(reader, APPROVALS_ROUTES, /recordAudit/),
      ...isolationSignals(reader, "agent_pending_approvals"),
      // the approve -> execute-as-owner step must be audited (who authorized what).
      approvalsAudited: anyFileMatches(reader, ["src/app/api/admin/agents/approvals"], /recordAudit/),
    };
  },
  criteria: [
    dbTestsCriterion(),
    e2eGatesCriterion(),
    isolationCriterion(),
    observabilityCriterion(),
    {
      id: "approval-execute-audited",
      dimension: "observability",
      kind: "auto",
      title: "Approve -> execute-as-owner is audited (who authorized what)",
      rationale:
        "The whole point of the human-in-the-loop gate is accountability: an executed action must carry who approved it. An unaudited execute path is an authority with no record.",
      status: (s) => (bool(s, "approvalsAudited") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "approvalsAudited") ? "execute path records an audit entry" : "no audit on the approval execute path"),
    },
  ],
};

export const READINESS_TOOLS: readonly ToolSpec[] = [aiCode, siteAnalytics, ogiamGate, agentApprovals];

export function toolById(id: string): ToolSpec | undefined {
  return READINESS_TOOLS.find((t) => t.id === id);
}
