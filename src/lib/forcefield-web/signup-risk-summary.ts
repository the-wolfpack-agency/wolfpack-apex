/**
 * Operator decision aid: a short AI risk / fit summary of a Forcefield signup
 * request, generated at review time to help an operator approve or reject.
 *
 * DOGFOODS the central model router: every call goes through getAIClient().
 * complete() - the one chokepoint - so it is cost-attributed, budget-gated,
 * routable to any provider, and its telemetry feeds the Model Limitation Profile
 * (we learn where each model struggles ON OUR OWN workflows). feature tag:
 * "forcefield.signup_risk_summary".
 *
 * GRACEFUL by construction: it NEVER throws into the caller and never blocks a
 * review. No provider / over budget / model error -> a typed `unavailable`
 * result the UI shows as "summary unavailable", never a 500 and never a blank.
 * It is advisory only: the human still decides, and the summary is derived from
 * the request fields the prospect supplied (no external fetch of their site).
 */
import { getAIClient } from "@/lib/ai";
import type { AIClient } from "@/lib/ai/types";
import { BudgetExceededError, NoProviderAvailableError } from "@/lib/ai/types";

export interface SignupRiskInput {
  name: string;
  email: string;
  siteUrl: string;
  note?: string | null;
}

export type SignupRiskResult =
  | { ok: true; summary: string; model: string; degraded: boolean }
  | { ok: false; reason: "unavailable" | "no_provider" | "over_budget" | "disabled" };

/**
 * Per-deployment AI kill-switch. When FORCEFIELD_AI_DISABLED is set, Forcefield
 * runs with ZERO AI touchpoints: this, the one operator-facing AI aid, is turned
 * off and no model is ever called. Lets us tell a security reviewer, truthfully,
 * "this deployment uses no AI at all" (the deterministic runtime already never
 * does; this covers the operator aid). Values: on / true / 1.
 */
export function isForcefieldAiDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FORCEFIELD_AI_DISABLED ?? "").toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

const SYSTEM =
  "You help an operator triage inbound requests for Forcefield, a website bot-defense " +
  "product. Given only the fields a prospect submitted (name, work email, site, note), " +
  "write 2-3 short sentences: who they appear to be, how plausible/legitimate the request " +
  "looks, and any obvious fit or risk signal (e.g. a free-mail address for a business " +
  "request, a mismatch between the email domain and the site). Be measured and factual. " +
  "You have NOT visited the site; never claim to. If there is little to go on, say so. " +
  "Do not invent facts. End with one of: LOOKS LEGITIMATE / NEEDS A LOOK / SUSPICIOUS.";

function prompt(input: SignupRiskInput): string {
  return [
    `Name: ${input.name}`,
    `Work email: ${input.email}`,
    `Site to protect: ${input.siteUrl}`,
    `Note: ${input.note?.trim() || "(none)"}`,
  ].join("\n");
}

/**
 * Produce the summary. `workspaceId` drives per-team cost attribution + budget;
 * `actor` is tagged for audit/telemetry. The AI client is injectable for tests.
 */
export async function summarizeSignupRisk(
  input: SignupRiskInput,
  ctx: { workspaceId?: string; actor?: { userId: string; role: string } },
  client: AIClient = getAIClient(),
): Promise<SignupRiskResult> {
  // AI kill-switch: when disabled for this deployment, never call a model.
  if (isForcefieldAiDisabled()) return { ok: false, reason: "disabled" };
  try {
    const res = await client.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(input) }],
      // Cheap tier: a short triage note, not a reasoning task - keeps it near-free
      // and high-volume-safe, and still exercises the router + limitation profile.
      model_tier: "cheap",
      max_tokens: 220,
      temperature: 0.2,
      sensitivity: "confidential", // a prospect's contact details
      latency_target: "real_time",
      metadata: {
        feature: "forcefield.signup_risk_summary",
        workspace_id: ctx.workspaceId,
        user_id: ctx.actor?.userId,
        user_role: ctx.actor?.role,
      },
    });
    const summary = res.content.trim();
    if (!summary) return { ok: false, reason: "unavailable" };
    return { ok: true, summary, model: res.model_used, degraded: res.degraded === true };
  } catch (err) {
    // Advisory feature: degrade to a typed result, never surface a 5xx.
    if (err instanceof BudgetExceededError) return { ok: false, reason: "over_budget" };
    if (err instanceof NoProviderAvailableError) return { ok: false, reason: "no_provider" };
    return { ok: false, reason: "unavailable" };
  }
}
