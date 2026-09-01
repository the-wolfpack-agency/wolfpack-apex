/**
 * Turning a walked system's traffic into the assessment findings that already
 * exist for single pages.
 *
 * anomaly/detect.ts answers "which outside hosts is this system contacting
 * that nothing accounts for, and which of them are new since last time". It is
 * careful, tested, and has only ever been given ONE page, by the compliance
 * scanner. A tracker that only loads on the settings screen has been invisible
 * to it for the life of the product.
 *
 * Nothing here re-implements any of that. It composes what exists: the
 * declarations builder, the host baseline, and the detector. What this module
 * contributes is the three things that are different about a walk.
 *
 * ONE: CONSENT WAS NEVER ASKED ABOUT. The walk signs in as an authorized user
 * of an internal system. Passing "no consent mechanism found" would be
 * literally true and completely misleading, stamping "fired before consent" on
 * every host in a client's report on the strength of a question nobody asked.
 *
 * TWO: THE DECLARATION COMES FROM THE ENTRY PAGE. One CSP, captured once,
 * applied to the whole walk, and null means not captured rather than absent.
 *
 * THREE: THE BASELINE MAKES A SECOND WALK WORTH MORE THAN THE FIRST. The first
 * walk of a system can say what it contacts. The second can say what CHANGED,
 * which is the finding somebody acts on. That only works if the first one was
 * written down, so folding the baseline forward is part of assessing rather
 * than an afterthought a caller might forget.
 */

import { buildDeclarations } from "../anomaly/declared";
import { detectAnomalies, foldBaseline, type AnomalyReport, type HostBaseline } from "../anomaly/detect";
import type { NetworkObservation } from "../network/observations";

export interface AssessWalkInput {
  entryUrl: string;
  observations: NetworkObservation[];
  /** Entry-page response headers. Null means NOT CAPTURED, not absent. */
  entryHeaders: Record<string, string> | null;
  /** Prior walk's hosts. Undefined means never walked, which is not empty. */
  baseline?: readonly HostBaseline[];
  /** Hosts an operator has already vouched for. */
  operatorAllowed?: readonly string[];
  /**
   * Hosts implied by integrations this workspace actually runs.
   *
   * The second source of truth. The target's own Content-Security-Policy is
   * often permissive enough to explain nothing, and this product separately
   * knows which integrations a workspace has connected and probes healthy.
   * Explains traffic from OUR systems; a third-party product's own vendors are
   * its own and will correctly remain unexplained.
   */
  integrationHosts?: readonly { host: string; name: string }[];
  /** False when the reader was not watching traffic at all. */
  trafficObserved: boolean;
  /** True when the observation set hit its cap. */
  trafficTruncated?: boolean;
  nowIso: string;
}

export interface WalkAssessment {
  report: AnomalyReport;
  /** Fold-forward baseline for the next walk, for the caller to persist. */
  nextBaseline: HostBaseline[];
  /** False when this walk should not be written back as a baseline. */
  worthPersisting: boolean;
}

export function assessWalkedTraffic(input: AssessWalkInput): WalkAssessment {
  const declarations = buildDeclarations({
    pageUrl: input.entryUrl,
    headers: input.entryHeaders,
    operatorAllowed: input.operatorAllowed,
    integrationHosts: input.integrationHosts,
  });

  const report = detectAnomalies({
    observations: input.observations,
    declarations,
    baseline: input.baseline,
    /* THE WHOLE REASON THIS MODULE EXISTS. See the header. */
    consentAssessed: false,
    pageLoaded: input.observations.length > 0 || input.trafficObserved,
  });

  if (!input.trafficObserved) {
    report.caveats.push(
      "This walk did not record outbound traffic, so no outside services are listed. That is a gap in the scan rather than a system that contacts nobody.",
    );
  }
  if (input.entryHeaders === null) {
    report.caveats.push(
      "Response headers were not captured, so the system's own Content-Security-Policy could not be used to tell an intended request from an unintended one. Nothing here says the system lacks one.",
    );
  }
  if (input.trafficTruncated) {
    report.caveats.push(
      "Traffic recording reached its limit during this walk, so the hosts listed are a floor rather than a complete set.",
    );
  }

  /* A WALK THAT SAW NOTHING MUST NOT BECOME THE BASELINE. One failed run would
     erase the history that makes "this is new" answerable, and every host
     would then look newly appeared on the next walk. The rule lives here so no
     caller has to remember it. */
  const worthPersisting = input.trafficObserved && input.observations.length > 0;

  return {
    report,
    nextBaseline: worthPersisting
      ? foldBaseline(input.baseline, input.observations, input.nowIso)
      : [...(input.baseline ?? [])],
    worthPersisting,
  };
}
