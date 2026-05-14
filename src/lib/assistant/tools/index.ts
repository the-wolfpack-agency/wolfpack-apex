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
