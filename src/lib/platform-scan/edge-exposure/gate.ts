/**
 * The gate in front of the edge-device exposure classifier.
 *
 * The classifier only ever runs for a target that has ALREADY passed the
 * fail-closed ownership verification (see [[apex-target-ownership-gate]]), and it
 * is OFF BY DEFAULT behind an explicit setting. This mirrors the ownership floor
 * every other active surface uses (pentest/guard.ts, browser/gate.ts): we never
 * fork the control, we reuse it.
 *
 * Fail-closed order (each an independent floor, refused before any work):
 *   1. OFF by default - the EDGE_EXPOSURE_ENABLED setting must be explicitly on.
 *   2. Ownership floor  - curated/internal target OR a client target proven owned
 *      (isTargetVerified). An unverified client target is refused.
 * Only then does the pure classifier run over the already-collected response.
 *
 * Every outcome is observed (platform.edge_exposure_detected / _blocked) and
 * written best-effort to the hash-chained audit log, so no data is lost. Audit is
 * best-effort and never throws into the caller (a ledger hiccup must not flip a
 * refusal into a run). This module does NO network I/O: the response is handed in
 * already collected.
 */

import type { ScanFinding } from "../types";
import { isCuratedTarget } from "@/lib/platform-scan/manifests";
import { isTargetVerified } from "@/lib/platform-scan/authorization";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { classifyEdgeExposure, classifyEdgeDevice, type EdgeHttpResponse } from "./classify";

/**
 * The edge-exposure classifier is OFF BY DEFAULT. It runs only when
 * EDGE_EXPOSURE_ENABLED is explicitly set to on/true/1. Any other value - and
 * crucially an UNSET variable - leaves it disabled. Mirrors the kill-switch idiom
 * (isKillSwitchEngaged) but inverted: a setting that must be turned ON, not OFF.
 */
export function isEdgeExposureEnabled(): boolean {
  const v = (process.env.EDGE_EXPOSURE_ENABLED ?? "").toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export interface EdgeExposureInput {
  workspaceId: string;
  platform: string;
  response: EdgeHttpResponse;
  actor: { userId: string; role: string };
}

export type EdgeExposureResult =
  | { ran: true; findings: ScanFinding[]; detected: boolean }
  | { ran: false; reason: string };

/** Injectable collaborators so the gate is unit-testable without env/DB/network.
 *  Defaults wire the real harness (the same modules the pentest/browser gates use). */
export interface EdgeExposureDeps {
  enabled?: () => boolean;
  curated?: (platform: string) => boolean;
  verified?: (workspaceId: string, platform: string) => Promise<boolean>;
  track?: typeof trackEvent;
  audit?: typeof recordAudit;
}

/** The actor + target the floor is evaluated for. */
export interface EdgeExposureFloorInput {
  workspaceId: string;
  platform: string;
  actor: { userId: string; role: string };
}

/** Write one best-effort audit entry for an edge-exposure decision. Never throws. */
export async function recordEdgeExposureAudit(
  audit: typeof recordAudit,
  input: EdgeExposureFloorInput,
  outcome: "detected" | "blocked" | "clean",
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await audit({
      actor: { user_id: input.actor.userId, role: input.actor.role },
      action: `platform.edge_exposure.${outcome}`,
      resourceType: "edge_exposure",
      resourceId: input.platform,
      afterState: { platform: input.platform, outcome, ...extra },
    });
  } catch {
    /* Audit is best-effort: the decision is already returned + tracked. */
  }
}

/**
 * The fail-closed floor on its own: OFF by default, then the ownership floor.
 * Returns null when the classifier may run, or the refusal reason after tracking
 * + auditing it. Shared by the single-response gate below and the scan pass
 * (pass.ts), so the two can never drift apart.
 */
export async function checkEdgeExposureFloor(
  input: EdgeExposureFloorInput,
  deps: EdgeExposureDeps = {},
): Promise<string | null> {
  const enabled = deps.enabled ?? isEdgeExposureEnabled;
  const curated = deps.curated ?? isCuratedTarget;
  const verified = deps.verified ?? isTargetVerified;
  const track = deps.track ?? trackEvent;
  const audit = deps.audit ?? recordAudit;

  let reason: string | null = null;
  // 1. OFF by default: the setting must be explicitly enabled.
  if (!enabled()) reason = "disabled";
  // 2. Ownership floor: curated/internal is exempt; any other target must be
  //    proven client-owned (fail-closed) before the classifier may run. A
  //    verification lookup that throws is a refusal, never a pass.
  else if (!curated(input.platform)) {
    let owned = false;
    try {
      owned = await verified(input.workspaceId, input.platform);
    } catch {
      owned = false;
    }
    if (!owned) reason = "unverified_target";
  }
  if (reason === null) return null;
  track("platform.edge_exposure_blocked", input.actor.userId, input.actor.role, { platform: input.platform, reason });
  await recordEdgeExposureAudit(audit, input, "blocked", { reason });
  return reason;
}

/**
 * Gate + run the edge-device exposure classifier for one already-collected
 * response. Returns { ran: false, reason } when refused by a floor, or
 * { ran: true, findings, detected } when it ran (findings may be empty: a clean
 * response that matched no edge device).
 */
export async function runEdgeDeviceExposure(
  input: EdgeExposureInput,
  deps: EdgeExposureDeps = {},
): Promise<EdgeExposureResult> {
  const track = deps.track ?? trackEvent;
  const audit = deps.audit ?? recordAudit;

  const { platform, response, actor } = input;
  const recordDecisionAudit = (outcome: "detected" | "blocked" | "clean", extra: Record<string, unknown>) =>
    recordEdgeExposureAudit(audit, input, outcome, extra);

  const refused = await checkEdgeExposureFloor(input, deps);
  if (refused !== null) return { ran: false, reason: refused };

  // Passed every floor: run the pure, offline classifier.
  const findings = classifyEdgeExposure(response);
  const match = findings.length > 0 ? classifyEdgeDevice(response) : null;
  const detected = findings.length > 0;

  if (detected && match) {
    const f = findings[0];
    track("platform.edge_exposure_detected", actor.userId, actor.role, {
      platform,
      product: match.product,
      vendor: match.vendor,
      kev_count: Number(f.evidence.kev_count ?? 0),
      severity: f.severity,
    });
    await recordDecisionAudit("detected", {
      product: match.product,
      vendor: match.vendor,
      kev_count: f.evidence.kev_count ?? 0,
      severity: f.severity,
    });
  } else {
    await recordDecisionAudit("clean", { route: response.route });
  }

  return { ran: true, findings, detected };
}
