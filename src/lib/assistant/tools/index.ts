/**
 * Tool barrel — importing this file registers every Phase-1 tool with
 * the dispatcher. Order matters: more-specific tools register FIRST so
 * they win the intent match before a general tool catches it.
 *
 * To add a new tool: create it under src/lib/assistant/tools/, call
 * registerTool() at module bottom, and import the file here.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// Phase 1 — read-only tools
import "./get-org-facts";

// Phase 2 — additional read-only tools (more-specific first so they win
// the intent cascade before a general tool catches them).
import "./get-financials-metric-tool"; // CTO/CEO only — most-specific
import "./search-mail-tool";
import "./get-calendar-availability-tool";
import "./get-goals-tool";

// Phase 3 — action tools (mutate state, behind the requiresConfirmation
// gate). Dispatcher returns needs_confirmation on first dispatch; the
// chat handler persists a pending action; the user's next turn confirms
// or cancels.
import "./save-team-fact-tool";

// Phase 4 — connector-backed tools (external CRMs / systems via
// generic REST adapter). Register AFTER connectors so the registry
// has them at tool-handler invocation time.
import "@/lib/assistant/connectors";
/* delegate_to_agent OWNS explicit agent-direction phrasings ("Agent1 add a
   task titled X", "tell Scout to log my hours", "@Scout draft the report").
   Registered BEFORE who_is and BEFORE the generic search / widget tools so an
   explicit "Agent1 ..." direction routes to the agent instead of being swallowed
   by another tool's intent. The handler enforces authorization (owner or
   manager-or-above) and the agent's own per-step OGIAM gate governs execution. */
import "./delegate-to-agent-tool";
/* execute_agent_widget OPENS the agent control plane (picker + task template)
   in chat. Registered AFTER delegate so an explicit "Agent1 <do X>" still
   executes immediately; this claims "run/execute/launch ... agent" only. */
import "./execute-agent-widget-tool";
/* who_is OWNS "who is <name>" — team-first, CRM-fallback. Registered
   BEFORE search_external_records so the cascade stops at the right
   answer: a literal teammate returns their roster info instead of
   the old "no contact match in the CRM" message. */
import "./who-is-tool";
import "./templates-tool";
import "./edit-routine-tool";
import "./schedule-routine-tool";
import "./platform-scan-tool";
import "./plan-my-day-tool";
import "./capabilities-tool";
/* Order matters: search_external_records claims TYPED CRM phrasings
   ("find the contact for X", "look up account X", "find
   grimace@x.com"). Bare-search phrasings ("search Acme", "look up
   Acme") used to land here too but now flow to Universal Search
   (registered later in this file) so the CRM provider fans in
   alongside chats/emails/calendar/knowledge. get_external_record
   then claims "look up <object> id <id>" phrases. Reversing this
   pair makes get_external_record's loose ID regex accidentally
   swallow single-word names. */
import "./search-external-records-tool";
import "./get-external-record-tool";
/* CRM record FORM — registered before the legacy regex-confirm
   create_external_record so "create a $10k deal with X" surfaces a
   form (with required StageName + CloseDate baked in) instead of
   the parse-confirm-write path that 400'd at the vendor. */
import "./create-crm-record-form-tool";

/* Form-trigger tools — return a FormSpec the chat UI renders inline so
   the user fills required fields before any side effect fires. These
   MUST be registered BEFORE the legacy create_external_record /
   update_external_record so "create task" / "create feature" /
   "create okr" route to their page-modal-parity forms instead of
   being swallowed by the loose CRM create regex
   (/\b(?:create|add|new)\b.*\b(?:task|activity)\b/) which would write
   to Salesforce instead. Order within the form group: message before
   email so "send message" doesn't match email's verb-noun stem; the
   other tools have disjoint object nouns. */
import "./create-message-form-tool";
/* create-email-form-tool disabled 2026-05-20 — the compose surface
   isn't production-ready (no send confirmation, no attachments,
   thin error handling on rate limits). Re-enable once hardened. */
// import "./create-email-form-tool";
import "./create-calendar-event-form-tool";
import "./log-time";
import "./scan-receipt";
import "./scan-invoice";
import "./scan-hr-doc";
import "./create-task-form-tool";
import "./create-okr-form-tool";
import "./create-feature-form-tool";

/* Legacy create / update — still handles "log a call with X about Y"
   (action-verb phrasings the form tools intentionally don't claim). */
import "./create-external-record-tool";
import "./update-external-record-tool";
/* Read-only advanced queries — related records ("Acme's opportunities")
   and filter queries ("deals over $50k closing this month"). */
import "./get-related-records-tool";
import "./filter-external-records-tool";
import "./aggregate-external-records-tool";

/* GitHub query tools — read-only against the org PAT. Standalone (not
   routed through the CRM connector framework) because PRs/Issues/Runs
   don't fit the Contact/Deal/Account model. PR tool first so the
   "issue" tool doesn't claim phrases containing "pull request". */
import "./search-github-pull-requests-tool";
import "./search-github-issues-tool";
import "./recent-workflow-runs-tool";

/* Widget tools — return an interactive surface (calendar grid, email
   thread, task list, etc.) instead of free-form text. The framework
   is shared so future widgets plug in via the same WidgetSpec
   discriminator. Order between widget tools doesn't matter — their
   INTENT_RE patterns are anchored ^/$ on disjoint nouns
   ("calendar" vs "inbox/emails" vs "tasks/todos"). */
import "./calendar-widget-tool";
import "./email-thread-widget-tool";
import "./task-list-widget-tool";
import "./good-morning-widget-tool";
/* Meeting Pre-Brief — the first cross-source synthesis tool. Single
 * Haiku call per (workspace, meeting, source_hash); shared across the
 * org. Registered alongside the calendar/email/task widget tools — its
 * intent regex is anchored ^/$ on "prep|brief … meeting" so it doesn't
 * compete with the bare "calendar"/"inbox" verbs above. */
import "./meeting-prep";
/* DMS inventory widget — bridges to the AgenticQA browser-driver
 * server. Proves the "we drive any DMS web UI" pattern; first
 * vendor is wolfpack-auto (we own it). CDK / Tekion / Reynolds
 * plug in server-side without changing this tool. */
import "./dms-inventory-widget-tool";
/* Vercel deployments widget — single-token Wolfpack-wide read-only
 * integration. Search provider sibling lives at lib/search/providers/
 * vercel.ts. Both auto-disable cleanly when VERCEL_API_TOKEN is unset. */
import "./vercel-deployments-widget-tool";
/* Cross-tool insights — fans across every connected integration and
 * surfaces signals no single tool can see. Rule-based detection;
 * zero AI tokens for the patterns themselves. */
import "./cross-tool-insights-widget-tool";
/* Integrations list — discoverability surface auto-discovered from
 * the search-provider + tool registries. */
import "./integrations-list-widget-tool";
/* Clarify — 1-tap "did you mean…?" chips for short typo'd queries.
 * Zero AI tokens; runs before the LLM path so a typo like "insighta"
 * gets chip suggestions instead of a cache-poisoning prose answer. */
import "./clarify-widget-tool";

/* Empty-state demo tools — weather / headlines / fx. Backed by free
 * public APIs (Open-Meteo, BBC RSS, exchangerate.host) so a brand-new
 * user with zero integrations connected still sees value within the
 * first 30 seconds. Registered AFTER the connector tools so a typed
 * connector phrasing never gets shadowed, but BEFORE Universal Search
 * so the very specific intent regexes ("weather in <city>", "top
 * headlines", "fx rate") aren't swallowed by the generic search
 * cascade. Each tool's INTENT_RE is anchored ^/$ on disjoint nouns
 * so they don't compete with each other. */
import "./weather";
import "./headlines";
import "./fx";

/* news_search — "the latest article about X", answered from public publisher
 * feeds. Registered HERE, beside headlines, and for the same reason: its intent
 * is anchored and specific, and Universal Search below would otherwise swallow
 * anything phrased as a search. It must come AFTER ./headlines because "top
 * headlines" (no topic) belongs to that tool, while "headlines about SpaceX"
 * belongs to this one; the two regexes are disjoint on whether a subject is
 * present, and registration order settles it either way. */
import "./news-search";

/* Upload-to-Brain tool — opens the dedicated drag/drop widget that
 * pushes files into the user's Brain via /api/brain/upload (filter
 * gate + existing ingest pipeline). Registered BEFORE the universal
 * `search` tool so "/upload" / "upload to brain" can't fall through
 * to the search cascade. INTENT_RE is anchored ^/$ on the literal
 * "upload" verb so it doesn't compete with the demo / connector
 * tools above. */
import "./upload-to-brain";

/* Feedback tool — the team-onboarding `/feedback <message>` slash
 * command. Writes to instinct_user_feedback (migration 143) and
 * returns the FeedbackWidget for the thank-you / compose surface.
 * Registered BEFORE the universal `search` tool so the slash-command
 * verb isn't shadowed; the intent regex anchors on the "feedback"
 * verb stem so it doesn't compete with other tools. */
import "./feedback";

/* Universal Search tool — returns IDENTICAL results to the /search
   page by delegating to lib/search/runSearch (which fans into the CRM
   connector via its `crm` provider). Registered AFTER the CRM tools
   so a typed-object phrasing the search tool's crmToolClaims missed
   would still cascade through to search_external_records on the
   second pass; in practice the typed regex catches them all. Bare-
   search phrasings ("search Acme", "look up Acme") flow here because
   search_external_records no longer claims the bare verb pattern
   (PATTERN 3 removed 2026-05-19) — Universal Search wins and its
   crm provider fans the same query back into the CRM in parallel
   with chats, emails, calendar, and knowledge. */
import "./search";

/* Declarative AGENT OPERATION tools, registered LAST, AFTER every curated
   human-facing tool, so a typed tool still wins the intent cascade for humans.
   Each operation in src/lib/agents/operations/registry.ts becomes an
   `op_<id>` tool with NO per-function handler code. They are `agentOnly`: the
   dispatcher skips them for a human caller (who uses the real product UI), so
   they only fire on an autonomous agent run and are invoked on the owner's
   behalf through the existing on-behalf delegation token. Importing the factory
   triggers its module-load registration. */
import "@/lib/agents/operations/tool-factory";

export { tryDispatchTool } from "./dispatcher";
export { getTools, getToolByName, registerTool, __resetRegistryForTests } from "./registry";
export type {
  ToolContext,
  ToolDef,
  ToolDispatchResult,
  ToolFailure,
  ToolResult,
  ToolSuccess,
} from "./types";

// Phase-3 confirmation flow surfaces
export {
  savePendingAction,
  consumeMostRecentPendingAction,
  detectConfirmationIntent,
  cleanupExpiredPendingActions,
} from "./pending-actions";
export type { PendingActionRow, ConfirmIntent } from "./pending-actions";
export { persistTeamFact } from "./save-team-fact-tool";
