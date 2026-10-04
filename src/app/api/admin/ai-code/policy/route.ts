/**
 * /api/admin/ai-code/policy - read + set a workspace's code-gate policy.
 *
 *   GET  -> 200 { policy: { protectedPaths[], denyRules[] } }
 *   PUT  { protectedPaths?, denyRules? } -> 200 { policy, warnings[] }
 *
 * The policy is ADDITIVE-ONLY (it can only tighten the gate; see policy.ts), so
 * there is no shape here that weakens a built-in rule. Input is sanitized server
 * side (bad regex / bad severity / over-cap entries dropped, reported in
 * `warnings`). Setting a policy is security-relevant, so it is recorded to the
 * hash-chained audit log AND emits ai_code.policy_set.
 *
 * Capability: settings.manage_team. Entitlement: secure_agent.
 * Returns: 200 | 400 (invalid JSON) | 401/403 (auth/entitlement) | 500 (write failed)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { trackEvent } from "@/lib/analytics";
import { recordAuditNonFatal, extractRequestMetadata } from "@/lib/audit-log";
import { sanitizePolicyInput } from "@/lib/ai-code/policy";
import { loadCodeGatePolicy, saveCodeGatePolicy } from "@/lib/ai-code/policy-store";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const policy = await loadCodeGatePolicy(auth.user.workspaceId);
  return NextResponse.json({ policy }, { status: 200 });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { policy, warnings } = sanitizePolicyInput(body);

  try {
    await saveCodeGatePolicy(auth.user.workspaceId, policy, auth.user.id);
  } catch {
    // A silent write failure would let the operator believe a control is live
    // when it is not; surface it as a 500 rather than a false success.
    return NextResponse.json({ error: "could not save policy" }, { status: 500 });
  }

  const meta = extractRequestMetadata(req);
  // Guarded (non-fatal) audit: the policy is already persisted; a transient
  // audit-write hiccup must not 500 a completed change. Mirrors the pipeline.
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.policy.updated",
    resourceType: "code_gate_policy",
    resourceId: auth.user.workspaceId,
    afterState: {
      workspace_id: auth.user.workspaceId,
      protected_paths: policy.protectedPaths.length,
      deny_rules: policy.denyRules.length,
      // the RULE TITLES are safe to record (not secrets); patterns stay out of
      // the audit body to keep it compact and non-sensitive.
      rule_titles: policy.denyRules.map((r) => r.title).slice(0, 50),
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  });

  trackEvent("ai_code.policy_set", auth.user.id, auth.user.role, {
    workspace_id: auth.user.workspaceId,
    protected_paths: policy.protectedPaths.length,
    deny_rules: policy.denyRules.length,
    warnings: warnings.length,
  });

  return NextResponse.json({ policy, warnings }, { status: 200 });
}
