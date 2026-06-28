/**
 * The gate-fronted browser-action authorizer: the model-agnostic safety contract
 * by which ANY AI browser driver (openclaw, or any other framework) must propose
 * each browser action to the OGIAM gate BEFORE acting on a client system. The AI
 * never touches the client directly: it PROPOSES an action, the gate DECIDES and
 * AUDITS, and only an allowed action is handed to the executor.
 *
 * The deterministic READ-ONLY FLOOR (mirrors the read-only http-scan tier):
 *   - Observation on a verified (or curated) target is the safe default. A
 *     read-only action (navigate / observe / hover / key, never mutating) needs
 *     no scope token; it runs through the gate in MONITOR mode so it is observed
 *     and audited but not blocked by policy graduation.
 *   - A MUTATING action (click / fill / submit, or mutating === true) is DENIED
 *     unless an ACTIVE scope authorizes it: a ui_probe technique in scope and the
 *     target host in the scope allowlist. It then runs the gate in ENFORCE mode,
 *     and a non-allow decision blocks. This is the same fail-closed shape as the
 *     active-pentest guard (assertPentestAuthorized); we MIRROR it, never fork it.
 *
 * Defense in depth, in order (each layer is an independent floor):
 *   kill switch (env, instant) -> ownership floor (curated OR verified target) ->
 *   SSRF guard (never internal/loopback/metadata, even when in scope) ->
 *   scope token (mutating only: active + ui_probe + host) -> OGIAM gate ->
 *   every decision recorded to the hash-chained audit log for compliance.
 *
 * NOTE ON CLICK: a click can submit a form, so click defaults to MUTATING. The
 * openclaw runner additionally enforces a network-layer floor that aborts every
 * non-GET/HEAD request, but THIS gate is the policy floor and does NOT trust the
 * driver: the driver could be any framework, or be compromised. The gate decides.
 */

import { authorize } from "@/lib/ogiam/authorize";
import type { OgiamDecision } from "@/lib/ogiam/types";
import { isKillSwitchEngaged } from "../pentest/guard";
import { getActiveScope } from "../pentest/scope";
import { isCuratedTarget } from "@/lib/platform-scan/manifests";
import { isTargetVerified } from "@/lib/platform-scan/authorization";
import { assertScannableUrl, SsrfBlockedError } from "../ssrf-guard";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

/** The browser actions a driver can propose. navigate/observe/hover/key are the
 *  read-only tier; click/fill/submit are the mutating tier. */
export type BrowserActionKind =
  | "navigate"
  | "observe"
  | "hover"
  | "key"
  | "click"
  | "fill"
  | "submit";

export interface BrowserAction {
  kind: BrowserActionKind;
  /** The fully-qualified URL the action targets (SSRF-checked). */
  targetUrl: string;
  /** The platform name (curated manifest key OR an onboarded client target). */
  platform: string;
  /** The DOM selector the action operates on, when applicable. */
  selector?: string;
  /** An explicit mutation override. A driver MAY set this true to force the
   *  mutating tier (e.g. a navigate that triggers a side-effecting redirect);
   *  it can never DOWNGRADE a mutating kind to read-only. */
  mutating?: boolean;
}

/** The read-only tier: observation actions that do not change client state. */
const READ_ONLY_KINDS: ReadonlySet<BrowserActionKind> = new Set<BrowserActionKind>([
  "navigate",
  "observe",
  "hover",
  "key",
]);

/**
 * An action is READ-ONLY when its kind is navigate/observe/hover/key AND the
 * driver did not flag it mutating. It is MUTATING when the kind is
 * click/fill/submit OR mutating === true. click defaults to mutating because a
 * click can submit a form; the flag can only UP-classify, never down-classify.
 */
export function isMutatingAction(action: BrowserAction): boolean {
  return action.mutating === true || !READ_ONLY_KINDS.has(action.kind);
}

export interface AuthorizeBrowserActionInput {
  workspaceId: string;
  action: BrowserAction;
  actor: { userId: string; role: string };
}

export type BrowserActionAuthResult =
  | { allowed: true; decision: OgiamDecision }
  | { allowed: false; reason: string };

/** Injectable collaborators so the contract is unit-testable without DB/network.
 *  Defaults wire the real harness (same modules the pentest guard uses). */
export interface BrowserGateDeps {
  killSwitch?: () => boolean;
  curated?: (platform: string) => boolean;
  verified?: (workspaceId: string, platform: string) => Promise<boolean>;
  assertScannable?: (url: string) => Promise<void>;
  activeScope?: typeof getActiveScope;
  gate?: typeof authorize;
  track?: typeof trackEvent;
  audit?: typeof recordAudit;
}

/**
 * THE CONTRACT every AI browser driver calls before touching a client system.
 *
 *   authorizeBrowserAction({ workspaceId, action, actor }) ->
 *     { allowed: true; decision } | { allowed: false; reason }
 *
 * On allow: fires platform.browser_action_allowed and returns the gate decision
 * (the driver hands the action to the executor). On any block: fires
 * platform.browser_action_blocked with the coarse reason and returns it (the
 * driver must NOT act). Every decision - allow or block - is written to the
 * hash-chained audit log. Audit is best-effort and never throws into the caller:
 * a ledger hiccup must not silently flip a deny into an allow.
 */
export async function authorizeBrowserAction(
  input: AuthorizeBrowserActionInput,
  deps: BrowserGateDeps = {},
): Promise<BrowserActionAuthResult> {
  const killSwitch = deps.killSwitch ?? isKillSwitchEngaged;
  const curated = deps.curated ?? isCuratedTarget;
  const verified = deps.verified ?? isTargetVerified;
  const assertScannable = deps.assertScannable ?? assertScannableUrl;
  const activeScope = deps.activeScope ?? getActiveScope;
  const gate = deps.gate ?? authorize;
  const track = deps.track ?? trackEvent;
  const audit = deps.audit ?? recordAudit;

  const { workspaceId, action, actor } = input;
  const { platform, kind, targetUrl } = action;
  const mutating = isMutatingAction(action);

  // Record every decision to the hash-chained audit log. Best-effort, mirroring
  // the connector-scope guard: a chain-write failure must NOT change the security
  // decision, so the throw is swallowed here.
  const recordDecisionAudit = async (
    outcome: "allowed" | "blocked",
    reason: string | null,
    host: string | null,
  ): Promise<void> => {
    try {
      await audit({
        actor: { user_id: actor.userId, role: actor.role },
        action: `platform.browser_action.${outcome}`,
        resourceType: "browser_action",
        resourceId: platform,
        afterState: { platform, kind, mutating, host, reason },
      });
    } catch {
      /* Audit is best-effort: the decision is already returned + tracked. */
    }
  };

  const block = async (reason: string, host: string | null = null): Promise<BrowserActionAuthResult> => {
    track("platform.browser_action_blocked", actor.userId, actor.role, {
      platform,
      action: kind,
      reason,
    });
    await recordDecisionAudit("blocked", reason, host);
    return { allowed: false, reason };
  };

  // 1. Kill switch: instant global halt, before anything else is consulted.
  if (killSwitch()) return block("kill_switch");

  // 2. Ownership floor: never drive a target the client has not proven they own.
  //    Curated/internal targets (the systems we operate) are exempt; any other is
  //    a client system that must pass ownership verification first.
  if (!curated(platform) && !(await verified(workspaceId, platform))) {
    return block("unverified_target");
  }

  // 3. SSRF floor: even a verified, in-scope target can NEVER point at an
  //    internal/loopback/metadata address. Absolute floor under the rules.
  let host: string;
  try {
    await assertScannable(targetUrl);
  } catch (e) {
    if (e instanceof SsrfBlockedError) return block("ssrf_blocked");
    throw e;
  }
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return block("invalid_target_url");
  }

  // 4. Scope floor (MUTATING ONLY). Read-only actions are the safe default tier
  //    and skip the scope requirement (like read-only http scans). A mutating
  //    action requires an active, unexpired scope whose techniques include
  //    ui_probe and whose host allowlist covers the target host.
  if (mutating) {
    const scope = await activeScope(workspaceId, platform);
    if (!scope) return block("no_active_scope", host);
    if (!scope.allowedTechniques.includes("ui_probe")) return block("ui_probe_not_in_scope", host);
    // Case-insensitive host match (URL.hostname is already lower-cased).
    if (!scope.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
      return block("host_not_in_scope", host);
    }
  }

  // 5. The gate. Mutating runs in ENFORCE (a non-allow decision blocks); read-only
  //    runs in MONITOR (observed + audited, never blocked by policy graduation),
  //    matching the read-only-scan posture.
  const decision = await gate({
    principal: {
      kind: "ai_agent",
      agent: "instinct.browser",
      onBehalfOfUserId: actor.userId,
      onBehalfOfRole: actor.role,
      workspaceId,
    },
    tool: "browser.action",
    capability: "platform.pentest",
    isMutation: mutating,
    surface: "/agent",
    params: { platform, kind, host },
    mode: mutating ? "enforce" : "monitor",
  });
  if (mutating && decision.effectiveOutcome !== "allow") {
    return block("gate_denied", host);
  }

  // 6. Allow: observe + audit, then return the decision to the driver.
  track("platform.browser_action_allowed", actor.userId, actor.role, {
    platform,
    action: kind,
  });
  await recordDecisionAudit("allowed", null, host);
  return { allowed: true, decision };
}
