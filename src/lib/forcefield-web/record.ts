/**
 * Forcefield for the Web - the watch-and-report recording adapter.
 *
 * The deterministic core (classify + posture) decides; this records the decision
 * so it shows up on the protection dashboard. Watch-first means every inspected
 * request leaves a trace whether or not it was blocked - that trace IS the
 * "you can see your agent traffic" promise.
 *
 * trackEvent is injected so this is unit-testable with no DB, matching the rest
 * of the effectiveness pipeline. The event is workspace-scoped in metadata so
 * the protection rollup can attribute it (same pattern as the enforcement
 * reader).
 */
import { trackEvent as liveTrackEvent } from "@/lib/analytics";
import type { WebVerdict } from "./classify";
import type { WebPostureDecision } from "./posture";

export const FORCEFIELD_WEB_EVENT = "forcefield_web.request_inspected";

export interface WebInspectionRecord {
  workspaceId: string;
  /** The site / property this request hit, so one workspace can watch many. */
  site: string;
  verdict: WebVerdict;
  decision: WebPostureDecision;
}

export interface RecordWebDeps {
  trackEvent: typeof liveTrackEvent;
}

export function liveRecordWebDeps(): RecordWebDeps {
  return { trackEvent: liveTrackEvent };
}

/**
 * Record one inspected web request. Best-effort and never throws into the hot
 * path: watching must not be able to break serving. The actor is the identified
 * agent when there is one, else a stable sentinel, so a per-agent view is
 * possible without inventing an identity for an anonymous visitor.
 */
export function recordWebInspection(rec: WebInspectionRecord, deps: RecordWebDeps): void {
  const actor = rec.verdict.matchedAgentId ?? "web.anonymous";
  try {
    deps.trackEvent(FORCEFIELD_WEB_EVENT, actor, "web", {
      workspace_id: rec.workspaceId,
      site: rec.site,
      class: rec.verdict.class,
      action: rec.decision.action,
      blocked: rec.decision.blocked,
      signal: rec.verdict.signal,
      agent_id: rec.verdict.matchedAgentId ?? "",
      trap_path: rec.verdict.matchedTrapPath ?? "",
    });
  } catch (err) {
    // Watching must never break serving; a recording failure is degraded
    // observability, not a served-request failure.
    console.warn("[forcefield-web] inspection record failed:", (err as Error)?.message ?? "unknown");
  }
}
