/**
 * Tool registry — process-wide store of all tools the Assistant can
 * dispatch. Tools register themselves at module load via `registerTool`.
 *
 * Order matters: the dispatcher tries each tool's matchIntent() in
 * registration order; the first match wins. Put more-specific tools
 * (e.g. "did <client> pay this month") above more-general ones
 * (e.g. "what do we know about <subject>") to avoid the general tool
 * shadowing the specific one.
 */

import type { ToolDef } from "./types";

const _registry: ToolDef<unknown, unknown>[] = [];

/**
 * Register a tool. Idempotent on the (name) primary key — re-registering
 * the same name replaces the prior definition (handy for tests).
 */
export function registerTool<P, R>(tool: ToolDef<P, R>): void {
  const existing = _registry.findIndex((t) => t.name === tool.name);
  if (existing >= 0) {
    _registry[existing] = tool as ToolDef<unknown, unknown>;
    return;
  }
  _registry.push(tool as ToolDef<unknown, unknown>);
}

/** Snapshot of all registered tools, in registration order. */
export function getTools(): ReadonlyArray<ToolDef<unknown, unknown>> {
  return _registry.slice();
}

/** Look up a tool by name, or `null` when unknown. */
export function getToolByName(
  name: string,
): ToolDef<unknown, unknown> | null {
  return _registry.find((t) => t.name === name) ?? null;
}

/** Test seam — wipe every registered tool (use sparingly). */
export function __resetRegistryForTests(): void {
  _registry.length = 0;
}
