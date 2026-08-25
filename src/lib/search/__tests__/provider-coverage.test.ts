/**
 * provider-coverage.test.ts
 *
 * Universal Search guardrail: every tool that exposes searchable data
 * MUST export a `searchProvider` and register it in
 * `src/lib/search/providers/index.ts`. Tools that legitimately have
 * no searchable data (mutations, lookups by ID, widget triggers,
 * action helpers) are explicitly allowlisted in
 * `SEARCH_PROVIDER_EXEMPT_TOOLS` with a one-phrase reason.
 *
 * The intent: when a future tool adds a new searchable surface
 * (Github issues, DMS inventory, financials, …), the author must
 * pick one of two paths and document the choice:
 *   1. Export a SearchProvider so Universal Search fans the query in.
 *   2. Add to the exempt allowlist with WHY (e.g. "lookup-by-ID
 *      only, not free-text searchable").
 *
 * This mirrors the audit-coverage / capability-coverage / openapi-
 * coverage pattern already used in the repo.
 *
 * Implementation detail: we read source files via fs instead of
 * importing the modules so the test stays fast (no module init, no
 * import side-effects).
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { SEARCH_PROVIDERS } from "@/lib/search/providers";

const TOOLS_DIR = join(__dirname, "..", "..", "assistant", "tools");

/** Files in src/lib/assistant/tools/ that aren't actually tools (they
 *  hold types / registries / dispatcher / helpers). Skipping these
 *  keeps the guardrail focused on real tool modules. */
const NON_TOOL_FILES = new Set([
  "index.ts",
  "registry.ts",
  "dispatcher.ts",
  "types.ts",
  "source-footer.ts",
  "pending-actions.ts",
  "brain-history.ts",
  "calendar-availability.ts",
  "financials-metric.ts",
  "github-query-client.ts",
  "goals-lookup.ts",
  "mail-search.ts",
  "meetings-on-date.ts",
]);

/**
 * Tools that don't need a SearchProvider, with the reason. New entries
 * MUST include a one-phrase reason so reviewers see WHY the tool
 * doesn't fan into Universal Search.
 */
export const SEARCH_PROVIDER_EXEMPT_TOOLS: Record<string, string> = {
  "github-repos.ts":
    "not a tool: shared helper that lists the repos this workspace manages and phrases the 'which repository?' question for the three GitHub tools",
  "dark-data-tool.ts":
    "schema-vs-statement diff over a connected database, nothing free-text searchable",
  "schedule-health-tool.ts":
    "analysis over calendar events already indexed by the calendar provider",
  "compare-across-sources-tool.ts":
    "analysis over two systems already searchable through their own connectors — nothing new to index",
  "templates-tool.ts":
    "lists pre-built workflows checked against the live registry, with no stored corpus to search",
  "edit-routine-tool.ts":
    "edits the caller's own saved chains; there is no corpus here to search",
  "schedule-routine-tool.ts":
    "creates and lists standing appointments for routines, with no corpus to search",
  "platform-scan-tool.ts":
    "reports counts and coverage for the workspace's own scans, with no free-text corpus to search",
  "plan-my-day-tool.ts":
    "reads a description the user just typed and maps it onto the registry, with no stored corpus to search",
  "capabilities-tool.ts":
    "describes the registry itself, so searching it would return the product's own menu rather than a user's data",
  "aggregate-external-records-tool.ts":
    "aggregate query (count / sum / win-rate / top-N) — not a free-text searchable surface",
  "calendar-widget-tool.ts":
    "renders an interactive calendar grid; calendar search lives in the calendar provider",
  "create-calendar-event-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-crm-record-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-email-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-external-record-tool.ts": "legacy mutation tool (write only)",
  "create-feature-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-message-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-okr-form-tool.ts": "form trigger (mutation, not searchable)",
  "create-task-form-tool.ts": "form trigger (mutation, not searchable)",
  "news-search.ts":
    "live public news feeds, not an indexable workspace surface — Universal Search covers our own data",
  "clarify-widget-tool.ts":
    "did-you-mean chip widget for typo'd queries; a disambiguation surface, not a searchable index",
  "cross-tool-insights-widget-tool.ts":
    "rule-based cross-integration insight widget; derives signals, not itself a searchable source",
  "execute-agent-widget-tool.ts":
    "opens the agent control-plane widget (run an agent); a task-launch surface, not a searchable index",
  "feedback.ts":
    "the /feedback slash-command tool; writes user feedback, returns a compose widget, not searchable",
  "gate.ts":
    "shared helper module (not a tool); exports the agent/role tool-access gate used by the dispatcher and scan",
  "integrations-list-widget-tool.ts":
    "discoverability widget enumerating connected integrations, not a free-text searchable surface",
  "log-time.ts": "time-logging action tool (write only, not searchable)",
  "scan-hr-doc.ts": "document-scan action tool (extracts + writes HR doc fields, not searchable)",
  "scan-invoice.ts": "document-scan action tool (extracts + writes invoice fields, not searchable)",
  "scan-receipt.ts": "document-scan action tool (extracts + writes receipt fields, not searchable)",
  "vercel-deployments-widget-tool.ts":
    "deployments widget; free-text Vercel search lives in the vercel provider (src/lib/search/providers/vercel.ts)",
  "delegate-to-agent-tool.ts":
    "delegation action tool; routes a human instruction to an agent, nothing searchable",
  "dms-inventory-widget-tool.ts":
    "specialized inventory widget with structured make/model/year/price filters; free-text DMS search lives in the dms provider (src/lib/search/providers/dms.ts)",
  "meeting-prep.ts":
    "synthesis tool — generates a per-meeting brief from cross-source data, not itself a searchable index",
  "portal-link.ts":
    "shared helper module (not a tool) — produces portal-link source refs for other tools",
  "resolve-connector.ts":
    "shared helper module (not a tool): scope-enforcing connector resolver used by the connector-backed tools, nothing searchable",
  "email-thread-widget-tool.ts":
    "widget rendering one specific thread; email search lives in the emails provider",
  "filter-external-records-tool.ts":
    "structured filter query (FilterSpec) — not free-text searchable",
  "get-calendar-availability-tool.ts": "availability lookup, not a free-text search",
  "get-external-record-tool.ts": "lookup-by-ID, not free-text searchable",
  "get-financials-metric-tool.ts": "scalar metric lookup, not free-text searchable",
  "get-goals-tool.ts": "structured goals lookup, not free-text searchable",
  "get-org-facts.ts": "structured org-facts lookup, not free-text searchable",
  "get-related-records-tool.ts":
    "possessive-relationship query (Acme's deals) — not free-text searchable",
  "good-morning-widget-tool.ts": "daily-briefing widget, not a searchable surface",
  "recent-workflow-runs-tool.ts":
    "GitHub Actions runs list; could surface via a github provider in a follow-up",
  "save-team-fact-tool.ts": "mutation tool (write only)",
  "search-external-records-tool.ts":
    "typed-object CRM search; the universal `crm` provider covers free-text CRM search",
  "search-github-issues-tool.ts":
    "GitHub-scoped search; could surface via a github provider in a follow-up",
  "search-github-pull-requests-tool.ts":
    "GitHub-scoped search; could surface via a github provider in a follow-up",
  "search-mail-tool.ts":
    "structured Outlook subject filter; free-text email search lives in the emails provider",
  "search.ts": "the Universal Search tool itself — delegates to the provider registry",
  "task-list-widget-tool.ts": "task widget; tasks aren't searchable today",
  "update-external-record-tool.ts": "mutation tool (write only)",
  "upload-to-brain.ts":
    "action tool, not a searchable data source — opens the drag/drop widget that pushes files into the Brain ingest pipeline",
  "who-is-tool.ts":
    "team-roster lookup with CRM fallback — name-only, not arbitrary free text",
  "weather.ts": "demo tool, ephemeral data, not searchable",
  "headlines.ts": "demo tool, ephemeral data, not searchable",
  "fx.ts": "demo tool, ephemeral data, not searchable",
};

const SEARCH_PROVIDER_EXPORT_RE = /export\s+(?:const|let|var)\s+searchProvider\b/;

describe("Universal Search provider coverage", () => {
  const allFiles = readdirSync(TOOLS_DIR).filter(
    (f) => f.endsWith(".ts") && !NON_TOOL_FILES.has(f),
  );

  it("finds at least a dozen tool files (sanity)", () => {
    expect(allFiles.length).toBeGreaterThan(12);
  });

  it.each(allFiles)("tool %s either exports searchProvider or is in the exempt allowlist", (file) => {
    const abs = join(TOOLS_DIR, file);
    const src = readFileSync(abs, "utf8");
    if (SEARCH_PROVIDER_EXPORT_RE.test(src)) return;
    if (Object.prototype.hasOwnProperty.call(SEARCH_PROVIDER_EXEMPT_TOOLS, file)) return;
    throw new Error(
      `Tool ${file} has no searchProvider export and is not in SEARCH_PROVIDER_EXEMPT_TOOLS. ` +
        `Either export a SearchProvider + register it in src/lib/search/providers/index.ts, ` +
        `or add an entry to SEARCH_PROVIDER_EXEMPT_TOOLS in this file with a one-phrase reason.`,
    );
  });

  it("every registered provider's `type` is a value of the SearchType literal union", () => {
    /* Compile-time guard: SearchType is a literal union with values
       enumerated below. Any registered provider whose type isn't in
       this set means SearchType wasn't extended when the provider
       was added — the consumer-facing TypeScript surface would
       silently widen. */
    const SEARCH_TYPE_VALUES = new Set([
      "chat",
      "channel",
      "email",
      "calendar",
      "knowledge",
      "crm",
      "dms",
      "vercel",
    ]);
    for (const provider of SEARCH_PROVIDERS) {
      expect(SEARCH_TYPE_VALUES.has(provider.type)).toBe(true);
    }
  });

  it("every exempt tool actually exists on disk", () => {
    /* Drift guard: if a tool is removed but its exempt entry stays,
       the allowlist quietly grows. Catch that. */
    for (const file of Object.keys(SEARCH_PROVIDER_EXEMPT_TOOLS)) {
      const abs = join(TOOLS_DIR, file);
      expect(() => readFileSync(abs, "utf8")).not.toThrow();
    }
  });
});
