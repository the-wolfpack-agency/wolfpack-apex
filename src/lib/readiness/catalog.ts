/**
 * Production-readiness engine - the tool catalog.
 *
 * Each tool declares how to scan the repo for its signals and which criteria
 * grade them. Criteria common to every production surface (DB-layer tests, an
 * E2E that gates on PRs, DB-enforced tenant isolation, analytics + hash-chained
 * audit) are defined ONCE here and reused by every tool (DRY). Only the
 * tool-specific criteria are written per tool.
 *
 * Evidence, not mentions: every matcher runs on comment-stripped code (scan.ts),
 * SQL checks parse individual statements (a policy must be ON the table, in the
 * same statement), negative checks require the surface to exist, and a DB test
 * counts only when it really opens TEST_DATABASE_URL. Each check has a vacuous-
 * pass regression fixture in __tests__/vacuous-pass.test.ts.
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
  fileLacks,
  fileMatches,
  hasForcedRls,
  hasImmutabilityTrigger,
  hasSessionVarPolicy,
  isRealDbTest,
  migrationStatements,
  noFileMatches,
  specGatesOnPR,
  tableHasColumn,
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

/** Isolation signals from parsed migration statements (comments removed):
 *  - workspace_id must be a column of THIS table, declared in a CREATE/ALTER TABLE
 *    statement for it (not a mention anywhere later in the file);
 *  - "DB enforced" needs a CREATE POLICY ON this table whose USING keys on the
 *    workspace GUC AND `FORCE ROW LEVEL SECURITY`, since the app role owns the
 *    tables and an owner bypasses unforced RLS. The audit found this check
 *    satisfied by a SQL comment in 196_platform_scan_rls.sql. */
function isolationSignals(reader: RepoReader, table: string): { isolationDbEnforced: boolean; isolationGuarded: boolean } {
  const stmts = migrationStatements(reader);
  const hasWorkspaceId = tableHasColumn(stmts, table, "workspace_id");
  const hasRealRls = hasSessionVarPolicy(stmts, table, "app.workspace_id") && hasForcedRls(stmts, table);
  return { isolationDbEnforced: hasWorkspaceId && hasRealRls, isolationGuarded: hasWorkspaceId && reader.exists(TENANT_GUARDRAIL) };
}

/** DB tests in src/db/__tests__ whose name matches `re` AND that really run
 *  against TEST_DATABASE_URL (a placeholder file is not a DB test). */
function namedDbTests(reader: RepoReader, re: RegExp): number {
  return reader
    .listFiles("src/db/__tests__", ".db.test.ts")
    .filter((p) => re.test(p) && isRealDbTest(reader, p)).length;
}

/** A call, not a mention: `trackEvent(` / `trackEventAwait(` / `recordAudit(` / `recordAuditNonFatal(`. */
const TRACK_CALL = /\btrackEvent\w*\s*\(/;
const AUDIT_CALL = /\brecordAudit\w*\s*\(/;

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
      ? "DB-level RLS keyed on the workspace GUC, FORCE ROW LEVEL SECURITY set (defense-in-depth)"
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
    const aiCodeDbTests = namedDbTests(reader, /ai.?code/i) + dbTestCount(reader, [...AI_CODE_ROUTES, ...AI_CODE_LIBS]);
    return {
      dbTestCount: aiCodeDbTests,
      e2eGatesOnPR: specGatesOnPR(wf, AI_CODE_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, AI_CODE_E2E),
      emitsAnalytics: anyFileMatches(reader, AI_CODE_ROUTES, TRACK_CALL),
      ...isolationSignals(reader, "instinct_ai_code_reviews"),
      // Negative check: the routes must EXIST and none may coalesce. Missing
      // routes read as coalescing (unknown), never as clean by absence.
      defaultWorkspaceCoalesce: !noFileMatches(reader, AI_CODE_ROUTES, /\?\?\s*["']default["']/),
      // deep static scan covers edits when it reads full changed files, not only new files.
      deepScanCoversEdits:
        fileMatches(reader, DEEP_SCAN, /changedFiles|changedLines|modifiedLines|editedFiles|addedLines/),
      // a transient audit-write never 500s a completed run: no bare `await recordAudit(`
      // in the routes (all post-hoc writes go through recordAuditNonFatal).
      auditCallsGuarded: noFileMatches(reader, AI_CODE_ROUTES, /await\s+recordAudit\(/) && anyFileMatches(reader, AI_CODE_ROUTES, /recordAuditNonFatal\s*\(/),
      // escalation/degrade surfaces on the response (degraded flag), so a kept
      // cheaper answer is never silent - the router tags it, not just analytics.
      noSilentTierDegrade: fileMatches(reader, "src/lib/ai/router.ts", /degraded: true/),
      // --- attested (centrally maintained; flip when closed) ---
      // the pipeline run writes an ai_code.pipeline_run entry via recordAuditNonFatal
      // -> recordAudit -> the hash-chained audit log (same as every other tool here).
      hashChainedAudit: anyFileMatches(reader, AI_CODE_ROUTES, AUDIT_CALL),
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
    // A real CREATE INDEX statement ON the events table covering the grouped
    // JSONB fields (or a GIN index on props). A mention in a comment is not one.
    const eventsHasSiteIndex = migrationStatements(reader).some((st) =>
      /\bCREATE (?:UNIQUE )?INDEX\b[\s\S]*\bON\s+(?:public\.)?site_analytics_events\b[\s\S]*(props\s*->>\s*'site'|props\s*->>\s*'fp'|USING gin)/i.test(st),
    );
    // This surface's DB tests live in src/db/__tests__ (events/operator/triage/
    // reputation) plus any under its routes. Count only the ones that cover it.
    const saDbTests = namedDbTests(reader, /site|operator|agent|triage|reputation|forcefield/i) + dbTestCount(reader, SA_ROUTES);
    return {
      dbTestCount: saDbTests,
      e2eGatesOnPR: specGatesOnPR(wf, SA_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, SA_E2E),
      emitsAnalytics: anyFileMatches(reader, SA_ROUTES, TRACK_CALL),
      hashChainedAudit: anyFileMatches(reader, SA_ROUTES, AUDIT_CALL),
      ...isolationSignals(reader, "site_analytics_events"),
      perfIndexes: eventsHasSiteIndex,
      // promote route must use the operator's real surface, not a hardcoded host.
      promoteSurfaceCorrect: noFileMatches(reader, SA_ROUTES, /SURFACE\s*=\s*["']ogiam\.com["']/),
      // the truthfulness engineering (n/a vs 0, hostile vs flagged) is present.
      truthfulnessHonest: fileMatches(reader, SA_LIB, /collectsPageViews|hostileOperators/),
      // ingest rate limit is DURABLE when the route no longer keeps in-memory
      // per-lambda counters (it delegates to the DB-backed checkRateLimit).
      durableRateLimit: noFileMatches(reader, SA_ROUTES, /let windowCount|let windowStart/) && anyFileMatches(reader, SA_ROUTES, /checkRateLimit\s*\(/),
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
    return {
      dbTestCount: dbTestCount(reader, [...OGIAM_ROUTES, ...OGIAM_LIBS]),
      e2eGatesOnPR: specGatesOnPR(wf, OGIAM_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, OGIAM_E2E),
      emitsAnalytics: anyFileMatches(reader, OGIAM_ROUTES, TRACK_CALL),
      // the ledger IS the hash-chained audit for agent actions.
      hashChainedAudit: anyFileMatches(reader, OGIAM_LIBS, /entry_hash|prev_hash|sha256/i),
      ...isolationSignals(reader, "ogiam_decisions"),
      // models advise, only POLICY authorizes: a pure decide() is the whole thesis.
      policyDecides: fileMatches(reader, "src/lib/ogiam/policy.ts", /export function decide/),
      // the ledger is hash-chained AND the rows are immutable (a DB trigger blocks UPDATE/DELETE).
      // A real CREATE TRIGGER ... BEFORE UPDATE/DELETE ON ogiam_* statement, not
      // the word "immutable" near "ogiam" anywhere in a migration.
      ledgerImmutable:
        anyFileMatches(reader, OGIAM_LIBS, /entry_hash|sha256/i) &&
        hasImmutabilityTrigger(migrationStatements(reader), "ogiam_"),
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
      emitsAnalytics: anyFileMatches(reader, APPROVALS_ROUTES, TRACK_CALL),
      hashChainedAudit: anyFileMatches(reader, APPROVALS_ROUTES, AUDIT_CALL),
      ...isolationSignals(reader, "instinct_agent_pending_approvals"),
      // the approve -> execute-as-owner step must be audited (who authorized what).
      approvalsAudited: anyFileMatches(reader, ["src/app/api/admin/agents/approvals"], AUDIT_CALL),
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

// ===========================================================================
// Tool: Forcefield  (/forcefield) - the self-serve agent-defense product
// ===========================================================================
// Forcefield's isolation model is NOT workspace_id: it is a per-tenant ingest
// token (sha256-resolved) that scopes every client-facing read to that tenant's
// forcefield_tenant_id. So this tool grades isolation on its OWN model, honestly,
// rather than reusing the workspace_id criterion that would wrongly read "gap".
const FF_ROUTES = ["src/app/api/forcefield", "src/app/api/admin/forcefield"];
const FF_TENANTS_LIB = "src/lib/forcefield-web/tenants.ts";
const FF_SIGNUP_LIB = "src/lib/forcefield-web/signup.ts";
const FF_MYSTATS = "src/app/api/forcefield/my-stats/route.ts";
const FF_SIGNUP_PUBLIC = "src/app/api/forcefield/signup/route.ts";
const FF_E2E = "tests/e2e/forcefield-dashboard.spec.ts";
const FF_SCOPING_GUARDRAIL = "src/lib/db/__tests__/tenant-scoping-register.test.ts";

const forcefield: ToolSpec = {
  id: "forcefield",
  label: "Forcefield (self-serve agent defense)",
  surface: "/forcefield",
  collectSignals(reader: RepoReader): ToolSignals {
    const wf = workflowTexts(reader);
    const ffDbTests = namedDbTests(reader, /forcefield/i);
    // Isolation: the client read path (my-stats) scopes by the resolved tenant id,
    // and the registry of tenant tables is held honest by the tenant-scoping guard.
    const tokenScopedReads =
      fileMatches(reader, FF_MYSTATS, /resolveTenantByToken/) &&
      fileMatches(reader, FF_MYSTATS, /tenant\.id/);
    const scopingGuardrail = reader.exists(FF_SCOPING_GUARDRAIL);
    // DB-level RLS on the tenant attribution column is the defense-in-depth goal.
    // A real policy ON site_analytics_events keyed on the tenant GUC, with RLS forced.
    const stmts = migrationStatements(reader);
    const tenantRls =
      hasSessionVarPolicy(stmts, "site_analytics_events", "app.forcefield_tenant") && hasForcedRls(stmts, "site_analytics_events");
    return {
      dbTestCount: ffDbTests,
      e2eGatesOnPR: specGatesOnPR(wf, FF_E2E),
      e2eSkipsGreen: e2eSkipsGreen(reader, FF_E2E),
      emitsAnalytics: anyFileMatches(reader, FF_ROUTES, TRACK_CALL),
      hashChainedAudit: anyFileMatches(reader, FF_ROUTES, AUDIT_CALL),
      tokenScopedIsolation: tokenScopedReads && scopingGuardrail,
      tenantRls,
      // Tokens are stored ONLY as a sha256 hash; a DB leak is not a credential leak.
      tokenHashedAtRest: fileMatches(reader, FF_TENANTS_LIB, /hashToken|token_sha256/),
      // The PUBLIC signup never mints a token - it only enqueues a pending request.
      signupGated: fileLacks(reader, FF_SIGNUP_PUBLIC, /token:/),
      // Signup rate limiting is DURABLE only when it no longer uses an in-memory map.
      durableRateLimit: fileLacks(reader, FF_SIGNUP_LIB, /rateBucket|new Map/),
    };
  },
  criteria: [
    dbTestsCriterion(),
    e2eGatesCriterion(),
    observabilityCriterion(),
    {
      id: "token-scoped-isolation",
      dimension: "isolation",
      kind: "auto",
      title: "A tenant token can only ever read its own tenant's data",
      rationale:
        "Forcefield's isolation is the per-tenant ingest token: the client read path resolves the token to a tenant and scopes every query to that tenant's id, so one client can never see another's numbers. DB-level RLS on the attribution column is the defense-in-depth goal.",
      status: (s) => (bool(s, "tenantRls") ? "ready" : bool(s, "tokenScopedIsolation") ? "partial" : "gap"),
      evidence: (s) =>
        bool(s, "tenantRls")
          ? "DB-level RLS on forcefield_tenant_id (defense-in-depth)"
          : bool(s, "tokenScopedIsolation")
            ? "token-resolved tenant scoping on the read path + tenant-scoping guardrail (enforced app-side); DB-level RLS pending"
            : "client reads not scoped by a resolved tenant id",
    },
    {
      id: "token-hashed-at-rest",
      dimension: "fail-closed",
      kind: "auto",
      title: "Ingest tokens are stored only as a hash, shown once at issue",
      rationale:
        "A token stored in the clear turns a DB read into a credential leak for every connected site. Storing only the sha256 means a leak is not a usable credential.",
      status: (s) => (bool(s, "tokenHashedAtRest") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "tokenHashedAtRest") ? "sha256 hash at rest, raw token shown once" : "token not hashed at rest"),
    },
    {
      id: "signup-gated",
      dimension: "correctness",
      kind: "auto",
      title: "Public signup never mints a token (operator-gated)",
      rationale:
        "Open token minting on an unauthenticated endpoint is an abuse surface: anyone could issue themselves ingest credentials that write into the shared analytics store. The public request must only enqueue a pending row an operator approves.",
      status: (s) => (bool(s, "signupGated") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "signupGated") ? "public signup enqueues a pending request only" : "public signup returns a token"),
    },
    {
      id: "durable-rate-limit",
      dimension: "fail-closed",
      kind: "auto",
      title: "Signup rate limiting is durable, not per-lambda in-memory",
      rationale:
        "An in-memory, cold-start-reset limit means a determined abuser (or a serverless fan-out) sails past the stated cap. A durable store-backed limit holds across instances.",
      status: (s) => (bool(s, "durableRateLimit") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "durableRateLimit") ? "durable store-backed limit" : "in-memory per-lambda limit (known gap)"),
    },
  ],
};

export const READINESS_TOOLS: readonly ToolSpec[] = [aiCode, siteAnalytics, ogiamGate, agentApprovals, forcefield];

export function toolById(id: string): ToolSpec | undefined {
  return READINESS_TOOLS.find((t) => t.id === id);
}
