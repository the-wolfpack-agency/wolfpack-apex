/**
 * POST /api/forcefield/edge/decide
 *
 * The inline decision an edge (reverse proxy / site middleware) calls per request
 * to get an allow / challenge / block / monitor verdict for one operator, BEFORE
 * serving. Deterministic: the policy is decideEdgeAction, not a model.
 *
 * The caller streams the behavioral signals it computed (trustBand, and the
 * principal verdict from ingest); this endpoint adds the server-AUTHORITATIVE
 * signals it alone can resolve - the operator blocklist and the cross-workspace
 * reputation network - then decides under the workspace's enforcement mode.
 *
 * PUBLIC: unauthenticated by design - an edge calls this before any user
 * session exists, so it is NOT capability-gated. It is locked down by a
 * shared-secret header `x-edge-token` == FORCEFIELD_EDGE_TOKEN (constant-time
 * compare); unset -> 503 (disabled), never open. No PII: opaque operator key
 * only. Returns 200 with the decision even in monitor mode. Same posture as the
 * site-analytics ingest endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { decideEdgeAction, qualifiesForAutoBlock, type EdgeSignals, type EdgePrincipalStatus } from "@/lib/forcefield/edge-enforcement";
import { getEdgePolicy } from "@/lib/forcefield/edge-policy";
import { listBlockedOperatorKeys, blockOperator } from "@/lib/agent-operators";
import { getNetworkReputation, type NetworkReputation } from "@/lib/forcefield/operator-reputation";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import type { TrustBand } from "@/lib/agent-operators-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDGE_WORKSPACE_ID = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
const TRUST_BANDS: TrustBand[] = ["trusted", "caution", "untrusted", "hostile"];
const PRINCIPAL_STATUSES: EdgePrincipalStatus[] = ["verified", "claimed", "absent"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.FORCEFIELD_EDGE_TOKEN;
  if (!expected) return NextResponse.json({ ok: false, error: "edge_disabled" }, { status: 503 });
  if (!tokenMatches(req.headers.get("x-edge-token") || "", expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { operatorKey?: unknown; trustBand?: unknown; principalStatus?: unknown; mandateExceeded?: unknown; proven?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const operatorKey = typeof body.operatorKey === "string" ? body.operatorKey.trim() : "";
  if (!operatorKey) return NextResponse.json({ ok: false, error: "invalid_input", detail: "operatorKey required" }, { status: 400 });

  const trustBand: TrustBand = TRUST_BANDS.includes(body.trustBand as TrustBand) ? (body.trustBand as TrustBand) : "caution";
  const principalStatus: EdgePrincipalStatus = PRINCIPAL_STATUSES.includes(body.principalStatus as EdgePrincipalStatus)
    ? (body.principalStatus as EdgePrincipalStatus)
    : "absent";

  // Server-authoritative signals the edge cannot know on its own.
  const blockedKeys = await listBlockedOperatorKeys(EDGE_WORKSPACE_ID).catch(() => new Set<string>());
  const rep: Record<string, NetworkReputation> = await getNetworkReputation(EDGE_WORKSPACE_ID, [operatorKey]).catch(() => ({}));
  const networkHostile = rep[operatorKey]?.severity === "hostile";

  const signals: EdgeSignals = {
    blocked: blockedKeys.has(operatorKey),
    trustBand,
    mandateExceeded: body.mandateExceeded === true,
    principalStatus,
    networkHostile,
  };
  const policy = await getEdgePolicy(EDGE_WORKSPACE_ID);
  const decision = decideEdgeAction(signals, policy);

  // Auto-block: when enforcement is on AND auto-block is enabled AND the operator
  // is PROVEN-hostile (never on inference, never a verified/good actor - see
  // qualifiesForAutoBlock), durably add it to the blocklist so it is stopped on
  // sight. Fingerprint-scoped (the opaque operator key), reversible, and audited.
  // This NEVER stops observation: the decision event below still fires, so the
  // agent keeps building its case file even while blocked.
  let autoBlocked = false;
  if (policy.mode === "enforce" && policy.autoBlock && !signals.blocked) {
    const q = qualifiesForAutoBlock(signals, { proven: body.proven === true });
    if (q.auto) {
      await blockOperator({ workspaceId: EDGE_WORKSPACE_ID, operatorKey, reason: `auto: ${q.reason}`, blockedBy: "forcefield.auto" }).catch(() => {});
      autoBlocked = true;
      trackEvent("forcefield.operator_auto_blocked", `operator:${operatorKey}`, "forcefield", {
        operator: operatorKey, rule: decision.ruleId, proven: true,
      });
      await recordAudit({
        actor: { user_id: "forcefield.auto", role: "system" },
        action: "operator.blocked",
        resourceType: "agent_operator",
        resourceId: operatorKey,
        afterState: { workspace_id: EDGE_WORKSPACE_ID, blocked: true, auto: true, reason: q.reason },
      }).catch(() => {});
    }
  }

  // Feed the enforcement learning loop. Opaque operator key only; no PII. Fires on
  // EVERY decision including a block - enforcement never blinds our collection.
  trackEvent("forcefield.edge_decision", `operator:${operatorKey}`, "external_agent", {
    operator: operatorKey,
    action: decision.action,
    intended: decision.intended,
    rule: decision.ruleId,
    mode: decision.mode,
    enforced: decision.enforced,
  });

  return NextResponse.json({ ok: true, decision, autoBlocked });
}
