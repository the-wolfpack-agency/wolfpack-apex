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
  title: "Tenant isolation is enforced at the database, not app-code only",
  rationale:
    "A USING(true) RLS policy or a table with no workspace_id means a single app-code bug (or a null workspace coalesced to a shared bucket) leaks one tenant's data to another on a shared database.",
  status: (s) => (bool(s, "isolationDbEnforced") ? "ready" : "gap"),
  evidence: (s) =>
    bool(s, "isolationDbEnforced")
      ? "real RLS policy + workspace scoping on this surface's tables"
      : "app-level WHERE workspace_id only, or USING(true) tripwire / missing workspace_id",
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
    const migrations = ["src/db/migrations"];
    // Isolation: the reviews migration (mentions instinct_ai_code_reviews) must
    // carry a real RLS policy, not USING(true).
    const hasReviewRls = anyFileMatches(reader, migrations, /instinct_ai_code_reviews[\s\S]*ROW LEVEL SECURITY/i);
    const tripwire = anyFileMatches(reader, migrations, /USING \(true\)/);
    return {
      dbTestCount: dbTestCount(reader, [...AI_CODE_ROUTES, ...AI_CODE_LIBS]),
      e2eGatesOnPR: specGatesOnPR(wf, AI_CODE_E2E),
      e2eSkipsGreen: fileMatches(reader, AI_CODE_E2E, /test\.skip\(/),
      emitsAnalytics: anyFileMatches(reader, AI_CODE_ROUTES, /trackEvent/),
      isolationDbEnforced: hasReviewRls && !tripwire,
      defaultWorkspaceCoalesce: anyFileMatches(reader, AI_CODE_ROUTES, /\?\?\s*"default"/),
      // deep static scan covers edits when it reads modified/changed lines, not only new files.
      deepScanCoversEdits:
        fileMatches(reader, DEEP_SCAN, /changedLines|modifiedLines|editedFiles|addedLines/),
      // --- attested (centrally maintained; flip when closed) ---
      hashChainedAudit: false, // only the PR-open action is chained; pipeline runs are plain events
      noSilentTierDegrade: false, // router inline escalation can still catch-and-keep the cheap answer
      retentionFailClosed: false, // AI_ZERO_RETENTION unset => sensitive egress is non-blocking
      auditCallsGuarded: false, // bare `await recordAudit` in pipeline/review can 500 a completed run
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
      kind: "attested",
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
      kind: "attested",
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
    const eventsHasWorkspace = anyFileMatches(
      reader,
      migrations,
      /site_analytics_events[\s\S]*workspace_id/i,
    );
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
      e2eSkipsGreen: fileMatches(reader, SA_E2E, /test\.skip\(/),
      emitsAnalytics: anyFileMatches(reader, SA_ROUTES, /trackEvent/),
      hashChainedAudit: anyFileMatches(reader, SA_ROUTES, /recordAudit/),
      isolationDbEnforced: eventsHasWorkspace,
      eventsWorkspaceScoped: eventsHasWorkspace,
      perfIndexes: eventsHasSiteIndex,
      // promote route must use the operator's real surface, not a hardcoded host.
      promoteSurfaceCorrect: !anyFileMatches(reader, SA_ROUTES, /SURFACE\s*=\s*"ogiam\.com"/),
      // the truthfulness engineering (n/a vs 0, hostile vs flagged) is present.
      truthfulnessHonest: fileMatches(reader, SA_LIB, /collectsPageViews|hostileOperators/),
      // --- attested ---
      durableRateLimit: false, // ingest rate limit is in-memory, per-lambda, cold-start-reset
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
      kind: "attested",
      title: "Ingest rate limiting is durable, not per-lambda in-memory",
      rationale:
        "An in-memory, cold-start-reset limit means a leaked ingest token floods far past the stated cap and inflates cost.",
      status: (s) => (bool(s, "durableRateLimit") ? "ready" : "gap"),
      evidence: (s) => (bool(s, "durableRateLimit") ? "durable store-backed limit" : "in-memory per-lambda limit"),
    },
  ],
};

/** Every tool under readiness tracking. Add a tool here to put it on the board. */
export const READINESS_TOOLS: readonly ToolSpec[] = [aiCode, siteAnalytics];

export function toolById(id: string): ToolSpec | undefined {
  return READINESS_TOOLS.find((t) => t.id === id);
}
