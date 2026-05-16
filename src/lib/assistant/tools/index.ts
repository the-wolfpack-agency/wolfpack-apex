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
/* Order matters: search claims free-text queries (multi-word names,
   emails, "who is X") via strict looksLikeIdNotName rejection of ID-
   shaped strings. get_external_record then claims the remaining
   "look up <object> id <id>" phrases. Reversing the order makes
   get_external_record's loose ID regex accidentally swallow
   single-word names. */
import "./search-external-records-tool";
import "./get-external-record-tool";
/* CRM record FORM — registered before the legacy regex-confirm
   create_external_record so "create a $10k deal with X" surfaces a
   form (with required StageName + CloseDate baked in) instead of
   the parse-confirm-write path that 400'd at the vendor. */
import "./create-crm-record-form-tool";
/* Legacy create / update — still handles "log a call with X about Y"
   (action-verb phrasings the form tool intentionally doesn't claim). */
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

/* Form-trigger tools — return a FormSpec the chat UI renders inline so
   the user fills required fields before any side effect fires. Order:
   message before email so "send message" doesn't match email's
   verb-noun stem. The other tools (OKR / feature / calendar / task)
   have disjoint object nouns so order between them doesn't matter.
   (create_crm_record_form is registered earlier alongside the CRM
   connector tools — see above.) */
import "./create-message-form-tool";
import "./create-email-form-tool";
import "./create-calendar-event-form-tool";
import "./create-task-form-tool";
import "./create-okr-form-tool";
import "./create-feature-form-tool";

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
