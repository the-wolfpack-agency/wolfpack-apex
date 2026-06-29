/**
 * POST /api/admin/platform-scans/browser/authorize: gate-as-a-service.
 *
 * The OGIAM browser-action gate (src/lib/platform-scan/browser/gate.ts,
 * authorizeBrowserAction) exposed over HTTP so ANY external AI browser driver
 * (openclaw, or any other framework/model) can get a gate DECISION before acting
 * on a client system. The driver PROPOSES one browser action; this route runs it
 * through the deterministic safety contract (kill switch -> ownership floor ->
 * SSRF guard -> scope token -> OGIAM gate -> hash-chained audit) and returns the
 * verdict. The driver branches on `allowed`: only an allowed action is handed to
 * its executor. This is the model-agnostic safety seam, callable out-of-process.
 *
 * Two auth paths (mirrors /api/admin/platform-scans/ingest exactly):
 *   1. Agent/CI path: Authorization: Bearer ${CRON_SECRET}. An external runner
 *      (openclaw, a CI job) hits this with the shared secret. Runs as the
 *      anonymous browser agent into the default workspace. False when unset.
 *   2. Admin path: requireCapability(req, "settings.manage_team") for an admin
 *      authorizing an action manually. workspaceId/actor come from the JWT.
 *   401/403 when neither path succeeds.
 *
 * THIS IS AN AUTHORIZATION QUERY, NOT THE ACTION ITSELF. A deny is therefore a
 * 200 with { allowed: false, reason }, NOT a 403: the HTTP status reports whether
 * the *query* was served, and the verdict lives in the body. The caller (the
 * runner) branches on `allowed`, never on the status code. A 403 is reserved for
 * "you may not ask the gate" (the admin lacks the capability), not "the gate said
 * no". This keeps the deny path observable rather than collapsing it into an auth
 * error the runner would mishandle.
 *
 * The gate itself audits every decision (hash-chained) and fires
 * platform.browser_action_allowed / _blocked inside authorizeBrowserAction; this
 * route does NOT duplicate either. It only parses, delegates, and serializes.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  authorizeBrowserAction,
  type BrowserActionKind,
} from "@/lib/platform-scan/browser/gate";
import { trackEvent } from "@/lib/analytics";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/** The seven actions the gate understands. navigate/observe/hover/key are the
 *  read-only tier; click/fill/submit are the mutating tier. */
const VALID_KINDS: ReadonlySet<string> = new Set<BrowserActionKind>([
  "navigate",
  "observe",
  "hover",
  "key",
  "click",
  "fill",
  "submit",
]);

interface AuthorizeBody {
  platform?: unknown;
  action?: {
    kind?: unknown;
    targetUrl?: unknown;
    selector?: unknown;
    mutating?: unknown;
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds (mirrors ingest).
  let workspaceId = "default";
  let actorId = "browser-agent";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // Agent/CI path: anonymous driver into the default workspace.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    workspaceId = auth.user.workspaceId ?? "default";
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  let body: AuthorizeBody;
  try {
    body = (await req.json()) as AuthorizeBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const action = body.action ?? {};
  const kind = typeof action.kind === "string" ? action.kind.trim() : "";
  const targetUrl =
    typeof action.targetUrl === "string" ? action.targetUrl.trim() : "";
  const selector =
    typeof action.selector === "string" ? action.selector : undefined;
  const mutating = action.mutating === true ? true : undefined;

  if (!platform || !kind || !targetUrl) {
    return NextResponse.json(
      { error: "platform, action.kind and action.targetUrl are required" },
      { status: 400 },
    );
  }
  if (!VALID_KINDS.has(kind)) {
    return NextResponse.json(
      {
        error:
          "action.kind must be one of navigate|observe|hover|key|click|fill|submit",
      },
      { status: 400 },
    );
  }

  // Delegate to the gate. It decides, audits (hash-chained), and tracks analytics
  // internally; we never duplicate any of that here.
  const verdict = await authorizeBrowserAction({
    workspaceId,
    action: {
      kind: kind as BrowserActionKind,
      targetUrl,
      platform,
      selector,
      mutating,
    },
    actor: { userId: actorId, role: actorRole },
  });

  if (verdict.allowed) {
    // FAIL CLOSED ON UNAUDITABLE. authorize() (called inside the gate) marks an
    // enforce-mode decision unauditable + wouldBlock when the tamper-evident
    // ledger write fails, but does NOT flip effectiveOutcome away from "allow".
    // The gate returns { allowed: true } in that case, so branching on
    // verdict.allowed alone would authorize a benign browser action UN-AUDITED.
    // Mirror the internal dispatcher (src/lib/assistant/tools/dispatcher.ts) and
    // refuse: no audit, no action. unauditable is only ever set in enforce mode,
    // so read-only (monitor) actions are unaffected.
    if (verdict.decision.unauditable) {
      // Keep the block observable: the gate already fired _allowed before we
      // overrode it, so surface the fail-closed override as a block event. A
      // normal policy deny already comes back as { allowed: false } from the
      // gate lib, so this branch keys ONLY on unauditable (mirrors the internal
      // dispatcher: no audit, no action).
      trackEvent("platform.browser_action_blocked", actorId, actorRole, {
        platform,
        action: kind,
        reason: "unauditable",
      });
      return NextResponse.json({
        allowed: false,
        reason: "unauditable: ledger unavailable, failing closed",
      });
    }
    // Echo a non-secret decision summary so the runner can correlate + log it.
    // Never echo params/host/principal - only the explainability fields.
    return NextResponse.json({
      allowed: true,
      decision: {
        ruleId: verdict.decision.ruleId,
        effectiveOutcome: verdict.decision.effectiveOutcome,
        mode: verdict.decision.mode,
        policyVersion: verdict.decision.policyVersion,
      },
    });
  }

  // Deny: a served query with a negative verdict. 200, not 403 (see header).
  return NextResponse.json({ allowed: false, reason: verdict.reason });
}
