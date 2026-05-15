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
