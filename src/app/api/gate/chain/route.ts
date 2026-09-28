/**
 * POST /api/gate/chain  { steps: [{ gate, input }], policy? }
 *
 * Run a WHOLE workflow - an ordered sequence of gates - in one call, so a client
 * can adopt the composition, not just individual gates. The chain advances on
 * `allow`, and stops at the first gate that returns auto_fix / require_human /
 * deny, returning where and why. Each gate decision is recorded to the
 * hash-chained ledger (same as the single-gate endpoint), so a chain run is fully
 * auditable and transparent.
 *
 * 200 { status, ranSteps, atGate?, finalOutput? } | 400 (bad body / unknown gate)
 * 401/403 auth/entitlement | 429 rate limit
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { getGate } from "@/lib/gates/registry";
import { runChain, type ChainStep } from "@/lib/gates/chain";
import { recordGateDecision } from "@/lib/gates/audit";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { DEFAULT_COMPLIANCE_POLICY, type CompliancePolicy } from "@/lib/gates/types";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const rl = await checkRateLimit(`gate:${auth.user.workspaceId ?? "default"}`);
  if (!rl.ok) return NextResponse.json({ error: "rate limit exceeded for gate calls; retry shortly" }, { status: 429 });

  let body: { steps?: unknown; policy?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "steps must be a non-empty array of { gate, input }" }, { status: 400 });
  }

  const steps: ChainStep[] = [];
  for (const raw of body.steps) {
    const step = raw as { gate?: unknown; input?: unknown };
    const name = typeof step.gate === "string" ? step.gate : "";
    const def = getGate(name);
    if (!def) return NextResponse.json({ error: `unknown gate in chain: ${name || "(missing)"}` }, { status: 400 });
    const input = step.input;
    steps.push({ gate: def, input: () => input });
  }

  const policy = policyFromBody(body.policy);
  const ctx = { workspaceId: auth.user.workspaceId ?? "default", actorId: auth.user.id, policy };

  const result = await runChain(steps, ctx, {
    onStep: async (gateName, r) => {
      // Every decision in the chain is a real gate decision - record it, unless
      // the gate already self-audited (recordedSeq present).
      if (r.recordedSeq == null) await recordGateDecision(gateName, r, ctx, "chain-step");
    },
  });

  return NextResponse.json(result);
}
