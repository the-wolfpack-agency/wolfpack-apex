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
 * Deps reads the LIVE agent-inspection stream the edge shim actually writes
 * (site_analytics_events site.agent_* events), optionally scoped to one surface.
 */
import { safeQuery } from "@/lib/db";
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

/** Map a live site event to the protection row shape. The forcefield edge shim
 *  stamps `action`/`blocked` into props; class is derived from the event type so
 *  the report is truthful even for legacy rows that predate those props. */
export function eventToInspection(eventType: string, action: string | null, blocked: boolean): WebInspectionRow {
  let cls: WebClass = "normal";
  if (eventType === "site.agent_welcomed") cls = "known_agent";
  else if (eventType === "site.agent_trap_tripped") cls = "trapped";
  else if (eventType === "site.agent_flagged" || eventType === "site.agent_probed_sensitive" || eventType === "site.agent_payload_attack" || eventType === "site.agent_high_rate" || eventType === "site.agent_form_honeypot" || eventType === "site.agent_form_too_fast") cls = "suspicious";
  const act = (action === "welcome" || action === "allow" || action === "report" || action === "block")
    ? (action as WebAction)
    : cls === "known_agent" ? "welcome" : cls === "normal" ? "allow" : "report";
  return { class: cls, action: blocked ? "block" : act, blocked };
}

const AGENT_EVENT_TYPES = [
  "site.agent_welcomed", "site.agent_flagged", "site.agent_trap_tripped",
  "site.agent_probed_sensitive", "site.agent_payload_attack", "site.agent_high_rate",
  "site.agent_form_honeypot", "site.agent_form_too_fast",
];

/** Reads the LIVE agent-inspection stream the edge shim actually writes
 *  (site_analytics_events), not the internal/demo event. Optionally scoped to one
 *  surface (site) via the workspaceId arg when it names a surface; "default"/empty
 *  reports across all monitored sites. */
export function liveWebProtectionDeps(): WebProtectionDeps {
  return {
    listInspections: async (workspaceId, limit) => {
      const surface = workspaceId && workspaceId !== "default" ? workspaceId : null;
      const { rows } = await safeQuery<{ event_type: string; action: string | null; blocked: boolean | string | null }>(
        `SELECT event_type,
                props->>'action' AS action,
                (props->>'blocked')::boolean AS blocked
           FROM site_analytics_events
          WHERE event_type = ANY($1)
            ${surface ? "AND props->>'site' = $2" : ""}
          ORDER BY created_at DESC
          LIMIT ${PAGE}`,
        surface ? [AGENT_EVENT_TYPES, surface] : [AGENT_EVENT_TYPES],
      );
      return rows.map((r) => eventToInspection(r.event_type, r.action, r.blocked === true || r.blocked === "true"));
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
