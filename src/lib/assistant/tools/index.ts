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
