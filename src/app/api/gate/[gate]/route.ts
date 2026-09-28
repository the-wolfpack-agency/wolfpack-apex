/**
 * POST /api/gate/[gate]  { input, policy? }  -> a single Agent Gate, deployable.
 *
 * This is the primitive's public surface: a client sends an input to ONE gate
 * and gets back a deterministic verdict, the findings, a client-facing
 * transparency record, and the hash-chained ledger seq the decision was recorded
 * under. A client can adopt one gate (e.g. safe-review before their own merge)
 * without the rest of the workflow.
 *
 * The framework enforces the client's data policy (runGate hands the gate a
 * policy-enforced agent) and records the decision to the OGIAM ledger. HTTP
 * status reflects whether the GATE RAN, not the verdict: a `deny` is a healthy
 * 200 with verdict:"deny" in the body.
 *
 * 200 { verdict, findings, reason, transparency, output?, recordedSeq }
 * 400 bad body | 401/403 auth/entitlement | 404 unknown gate
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { getGate } from "@/lib/gates/registry";
import { runGate } from "@/lib/gates/run-gate";
import { recordGateDecision } from "@/lib/gates/audit";
import { DEFAULT_COMPLIANCE_POLICY, type CompliancePolicy, type GateAgent } from "@/lib/gates/types";
import { getAIClient } from "@/lib/ai";

/** Build the client's compliance policy from the request, falling back to the
 *  safe default (deterministic only, no data to any model). Only recognized
 *  fields are read - an off-spec body cannot widen the policy. */
function policyFromBody(raw: unknown): CompliancePolicy {
  if (!raw || typeof raw !== "object") return DEFAULT_COMPLIANCE_POLICY;
  const p = raw as Record<string, unknown>;
  const allow = p.allowModelData;
  return {
    frameworks: Array.isArray(p.frameworks) ? p.frameworks.filter((f): f is string => typeof f === "string") : [],
    dataResidency: typeof p.dataResidency === "string" ? p.dataResidency : undefined,
    allowModelData: allow === "full" || allow === "redacted" ? allow : "none",
    redactions: Array.isArray(p.redactions) ? p.redactions.filter((r): r is string => typeof r === "string") : [],
    retentionDays: typeof p.retentionDays === "number" ? p.retentionDays : undefined,
  };
}

/** The client's model, exposed to the gate as a GateAgent (a simple
 *  prompt-in/text-out shape). runGate wraps this to enforce the policy; a
 *  deterministic gate simply never calls it. Cheap tier by default - a gate
 *  escalates its own tier only when it needs to. */
function clientAgent(workspaceId: string, userId: string, role: string): GateAgent {
  const ai = getAIClient();
  return {
    complete: (req) =>
      ai
        .complete({
          messages: [{ role: "user", content: req.prompt }],
          max_tokens: 4096,
          model_tier: "cheap",
          metadata: { feature: req.feature, workspace_id: workspaceId, user_id: userId, user_role: role },
        })
        .then((r) => ({ content: r.content, model_used: r.model_used })),
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ gate: string }> }): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { gate: gateName } = await ctx.params;
  const def = getGate(gateName);
  if (!def) return NextResponse.json({ error: `unknown gate: ${gateName}` }, { status: 404 });

  const entitlement = def.entitlement;
  if (entitlement) {
    const gateResp = await requireEntitlement(auth.user.workspaceId, entitlement);
    if (gateResp) return gateResp;
  }

  let body: { input?: unknown; policy?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.input === undefined || body.input === null) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  const policy = policyFromBody(body.policy);
  const result = await runGate(def, body.input, {
    workspaceId: auth.user.workspaceId ?? "default",
    actorId: auth.user.id,
    agent: clientAgent(auth.user.workspaceId ?? "default", auth.user.id, auth.user.role),
    policy,
  });

  const { recordedSeq } = await recordGateDecision(gateName, result, {
    workspaceId: auth.user.workspaceId ?? "default",
    actorId: auth.user.id,
    policy,
  }, body.input);

  return NextResponse.json({
    gate: gateName,
    verdict: result.verdict,
    findings: result.findings,
    reason: result.reason,
    transparency: result.transparency,
    ...(result.output !== undefined ? { output: result.output } : {}),
    recordedSeq,
  });
}
