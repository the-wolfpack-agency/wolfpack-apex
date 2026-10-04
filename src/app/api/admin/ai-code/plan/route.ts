/**
 * /api/admin/ai-code/plan - decompose a goal into a PROPOSE-ONLY multi-step plan.
 *
 *   POST { goal, context? } -> 200 { plan: { goal, steps[], truncated, model } }
 *
 * The plan is a list of proposed prompts. This route NEVER executes anything: a
 * human reviews the steps and launches each one through /api/admin/ai-code/pipeline
 * (the normal governed run). Multi-step autonomy therefore adds no new execution
 * path - every step is still one gated, human-approved run.
 *
 * Capability: settings.manage_team (same as the pipeline). Entitlement: secure_agent.
 * Emits ai_code.plan_proposed. A missing goal is a 400, never a 500; a model/parse
 * failure returns 200 with an empty plan (the UI says "could not plan").
 *
 * Returns: 200 { plan } | 400 (missing goal) | 401/403 (auth/entitlement)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { trackEvent } from "@/lib/analytics";
import { getAIClient } from "@/lib/ai";
import { proposePlan } from "@/lib/ai-code/plan";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { goal?: unknown; context?: unknown };
  const goal = typeof b.goal === "string" ? b.goal.trim() : "";
  const context = typeof b.context === "string" ? b.context : undefined;
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  const client = getAIClient();
  const plan = await proposePlan({ complete: (r) => client.complete(r), goal, context });

  trackEvent("ai_code.plan_proposed", auth.user.id, auth.user.role, {
    workspace_id: auth.user.workspaceId,
    goal_len: goal.length,
    steps: plan.steps.length,
    truncated: plan.truncated,
    model: plan.model ?? "none",
  });

  return NextResponse.json({ plan }, { status: 200 });
}
