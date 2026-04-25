/**
 * automations / registry — central index of every registered automation.
 *
 * Adding a new automation is a TWO-STEP change:
 *   1. write `src/lib/automations/<my-automation>/index.ts` exporting an
 *      `AutomationDefinition`.
 *   2. import it here and add it to the `REGISTRY` array.
 *
 * That's the whole config story — the `/automations`, `/automations/[id]`,
 * `/automations/[id]/changes` etc. pages all read from this file via
 * `getAutomation` / `listAutomations`, so a new automation lights up the
 * dashboard without touching any UI.
 *
 * Pure module — no I/O, no network. Safe to import server- AND client-
 * side, but parsers / assemblers are server-only by convention (they do
 * file I/O and call writeQuery), so a client component should only ever
 * use `listAutomations` for metadata.
 */

import type {
  AutomationDefinition,
  AutomationId,
} from "@/lib/automations/types";
import { porscheClasses } from "./porsche-classes";

const REGISTRY: ReadonlyArray<AutomationDefinition> = [porscheClasses];

const REGISTRY_INDEX: ReadonlyMap<AutomationId, AutomationDefinition> = new Map(
  REGISTRY.map((a) => [a.id, a]),
);

/**
 * Look up a single automation by id. Returns null when no automation
 * with the given id is registered, so callers (API routes, ingest
 * orchestrator) can convert that to a 404.
 */
export function getAutomation(
  id: AutomationId | string,
): AutomationDefinition | null {
  return REGISTRY_INDEX.get(id as AutomationId) ?? null;
}

/**
 * List every registered automation. Used by the index dashboard page
 * and by guard tests that assert every entry has the required parsers.
 */
export function listAutomations(): ReadonlyArray<AutomationDefinition> {
  return REGISTRY;
}

/**
 * Lightweight metadata projection of `listAutomations` — drops the
 * (server-only) parsers + assembler so it's safe to serialize to the
 * client. Used by the dashboard `/automations` page list.
 */
export interface AutomationMetadata {
  id: AutomationId;
  name: string;
  owner_label: string;
  description: string;
  active_window_days: { min: number; max: number };
  source_types: ReadonlyArray<string>;
  has_summary_assembler: boolean;
}

export function listAutomationMetadata(): ReadonlyArray<AutomationMetadata> {
  return REGISTRY.map((a) => ({
    id: a.id,
    name: a.name,
    owner_label: a.owner_label,
    description: a.description,
    active_window_days: a.active_window_days,
    source_types: Object.keys(a.parsers),
    has_summary_assembler: typeof a.assemble_summary === "function",
  }));
}
