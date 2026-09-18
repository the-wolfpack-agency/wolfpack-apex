/**
 * Forcefield for the Web - protection rollup for the watch-and-report dashboard.
 *
 * Reads the inspection events for a workspace and reports, in plain counts, how
 * the site's agent traffic was handled: welcomed (known good agents), trapped
 * (decoy trips), reported (weak hints + monitor-mode trips), blocked (turned
 * away), and normal visitors. Truthful by construction: counts only, straight
 * from the event log; an empty log is an honest zero, not a fabricated figure.
 *
 * The reader is injected so this is unit-testable with no DB; liveWebProtection
 * Deps wires the real event query (scoped by metadata->>'workspace_id', the same
 * mechanism the enforcement reader uses).
 */
import { safeQuery } from "@/lib/db";
import { FORCEFIELD_WEB_EVENT } from "./record";
import type { WebClass } from "./classify";
import type { WebAction } from "./posture";

export interface WebInspectionRow {
  class: WebClass;
  action: WebAction;
  blocked: boolean;
}

export interface WebProtectionReport {
  /** Every inspected request. */
  inspected: number;
  /** Known good agents given the welcome lane. */
  welcomed: number;
  /** Normal visitors / undeclared clients allowed through. */
  allowed: number;
  /** Signals recorded but not blocked (weak hints + monitor-mode decoy trips). */
  reported: number;
  /** Requests actually turned away (enforce-mode decoy trips). */
  blocked: number;
  /** Decoy trips seen, blocked or not - the high-confidence hostile signal. */
  decoyTrips: number;
  /** True when the reader hit its page cap, so counts are a lower bound. */
  sampleCapped: boolean;
}

export interface WebProtectionDeps {
  listInspections: (workspaceId: string, limit: number) => Promise<WebInspectionRow[]>;
}

const PAGE = 1000;

export function liveWebProtectionDeps(): WebProtectionDeps {
  return {
    listInspections: async (workspaceId, limit) => {
      const { rows } = await safeQuery<{ class: WebClass; action: WebAction; blocked: boolean | string }>(
        `SELECT metadata->>'class' AS class,
                metadata->>'action' AS action,
                (metadata->>'blocked')::boolean AS blocked
           FROM instinct_events
          WHERE event_type = $1
            AND metadata->>'workspace_id' = $2
          ORDER BY timestamp DESC
          LIMIT ${PAGE}`,
        [FORCEFIELD_WEB_EVENT, workspaceId],
      );
      return rows.map((r) => ({
        class: r.class,
        action: r.action,
        blocked: r.blocked === true || r.blocked === "true",
      }));
    },
  };
}

export function emptyWebProtectionReport(): WebProtectionReport {
  return { inspected: 0, welcomed: 0, allowed: 0, reported: 0, blocked: 0, decoyTrips: 0, sampleCapped: false };
}

export async function computeWebProtection(
  workspaceId: string,
  deps: WebProtectionDeps,
): Promise<WebProtectionReport> {
  const rows = await deps.listInspections(workspaceId, PAGE);
  const report = emptyWebProtectionReport();
  report.inspected = rows.length;
  report.sampleCapped = rows.length >= PAGE;
  for (const r of rows) {
    if (r.class === "trapped") report.decoyTrips++;
    switch (r.action) {
      case "welcome":
        report.welcomed++;
        break;
      case "allow":
        report.allowed++;
        break;
      case "report":
        report.reported++;
        break;
      case "block":
        report.blocked++;
        break;
    }
  }
  return report;
}
