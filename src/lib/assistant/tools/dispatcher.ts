/**
 * Tool dispatcher — runs the intent → params → validation → capability
 * → handler → audit + analytics pipeline.
 *
 * Called by `chat()` as Priority 0 (before knowledge cache / brain /
 * AI). Returns null when no tool's intent matches → chat() falls
 * through to the existing priority chain.
 *
 * Hard rules:
 *   - Tool handlers NEVER throw. The dispatcher catches anything
 *     escaping a handler and converts to a structured ToolFailure.
 *   - Every dispatch attempt (match + execute) emits typed analytics
 *     so the learning loop has full visibility.
 *   - Read-only tools (default) execute directly. Action tools must
 *     have `requiresConfirmation = true` so the dispatcher returns a
 *     `needs_confirmation` failure instead of mutating state on the
 *     first turn. (Phase 3 wires the confirm-then-execute flow.)
 */

import { trackEvent } from "@/lib/analytics";
import { authorize } from "@/lib/ogiam/authorize";
import { canInvokeTool } from "./gate";
import { getTools } from "./registry";
import type {
  ToolContext,
  ToolDef,
  ToolDispatchResult,
  ToolFailure,
  ToolResult,
} from "./types";

/**
 * Try to dispatch a tool for the given message. Returns the result of
 * the FIRST tool whose intent matches, or null if no tool matched.
 *
 * The dispatcher always returns a result object when a match is found
 * — even on failure — so the caller can distinguish:
 *   - null            → fall through to next priority
 *   - {result.ok:true}  → render the tool's answer + sources
 *   - {result.ok:false} → surface the failure (validation, capability,
 *                          internal) to the user with a deterministic
 *                          message; never call the LLM in this branch.
 */
export async function tryDispatchTool(
  message: string,
  ctx: ToolContext,
): Promise<ToolDispatchResult | null> {
  if (!message || message.trim().length === 0) return null;

  const tools = getTools();
  for (const tool of tools) {
    const params = safeMatchIntent(tool, message);
    if (params === null) continue;

    /* Human-only tools (e.g. delegate_to_agent) are never invoked BY an agent
       principal. Skip rather than fail, so the instruction falls through to the
       real work tool, and an agent can never delegate to another agent (a
       privilege-escalation path). */
    if (ctx.agentPrincipal && tool.humanOnly) continue;

    /* The inverse: agent-only tools (the declarative operation registry) are
       never invoked by a HUMAN caller. A human's "create a QR code" must reach
       the real product UI, not this on-behalf delegation path, so skip and let
       the instruction fall through to a human-facing tool / the LLM. */
    if (!ctx.agentPrincipal && tool.agentOnly) continue;

    const started = Date.now();
    const result = await runOneTool(tool, params, ctx);
    const durationMs = Date.now() - started;

    /* workflow_id correlates this dispatch back to the user message
     * that triggered it — same id is on the intent_unmatched event
     * (when it would have fired) + every widget interaction the
     * resulting render produces. Optional so legacy callers that
     * don't generate one still work. */
    const wid = ctx.workflowId;
    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: tool.name,
      success: result.ok,
      code: result.ok ? "ok" : result.code,
      duration_ms: durationMs,
      ...(wid ? { workflow_id: wid } : {}),
    });
    if (!result.ok) {
      trackEvent("assistant.tool_failed", ctx.userId, ctx.userRole, {
        tool: tool.name,
        code: result.code,
        message: result.message.slice(0, 200),
        ...(wid ? { workflow_id: wid } : {}),
      });
    } else {
      trackEvent("assistant.tool_succeeded", ctx.userId, ctx.userRole, {
        tool: tool.name,
        duration_ms: durationMs,
        ...(wid ? { workflow_id: wid } : {}),
      });
    }

    return { tool: tool.name, result, durationMs };
  }

  return null;
}

/** Bullet-proof matchIntent invocation — a tool that throws in its
 *  intent classifier MUST NOT silence later tools. */
function safeMatchIntent<P>(
  tool: ToolDef<P, unknown>,
  message: string,
): P | null {
  try {
    return tool.matchIntent(message);
  } catch {
    return null;
  }
}

async function runOneTool<P, R>(
  tool: ToolDef<P, R>,
  rawParams: unknown,
  ctx: ToolContext,
): Promise<ToolResult<R>> {
  /* 1. Validate parameters against the zod schema. */
  const parsed = tool.paramSchema.safeParse(rawParams);
  if (!parsed.success) {
    return failure(
      "validation",
      `parameters failed validation for ${tool.name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  /* 1b. OGIAM authorization. Record the deterministic decision for this
         well-formed action BEFORE the legacy gates, so even a mutation the
         dispatcher is about to bounce is captured.

         For the human assistant this runs in MONITOR mode (records the would-be
         decision, never blocks). For an AGENT principal it runs in ENFORCE mode
         and is attributed to the agent's own identity: a blocking decision
         (deny or escalate) actually refuses the action, and a gate failure fails
         safe (denies) rather than silently allowing. That is what makes an
         autonomous agent governed: every step is authorized under its identity,
         and high-risk steps are stopped, not just logged. */
  const agent = ctx.agentPrincipal;
  try {
    const decision = await authorize({
      principal: agent
        ? {
            kind: "ai_agent",
            agent: agent.agentId,
            onBehalfOfUserId: agent.agentId,
            onBehalfOfRole: agent.role,
            workspaceId: agent.workspaceId,
            ownerUserId: agent.ownerUserId,
          }
        : {
            kind: "ai_agent",
            agent: "instinct.assistant",
            onBehalfOfUserId: ctx.userId,
            onBehalfOfRole: ctx.userRole,
            workspaceId: ctx.workspaceId ?? "default",
          },
      tool: tool.name,
      capability: tool.capability,
      isMutation: Boolean(tool.requiresConfirmation),
      surface: agent ? "/agent" : "/assistant",
      workflowId: ctx.workflowId,
      params: parsed.data,
      mode: agent ? "enforce" : "monitor",
    });
    if (agent && decision.enforced && decision.wouldBlock) {
      return failure(
        "capability",
        `OGIAM ${decision.intendedOutcome}: ${decision.reason} (rule ${decision.ruleId})`,
      );
    }
  } catch {
    /* Human (monitor) dispatch must never break on a gate error. An agent
       (enforce) must fail closed: no authorization, no action. */
    if (agent) return failure("internal", "authorization gate unavailable");
  }

  /* 2. Role gate (shared with the agent self-onboarding scan, see ./gate).
        "*" = any authenticated principal. */
  if (!canInvokeTool(ctx.userRole, tool.capability)) {
    return failure(
      "capability",
      `tool ${tool.name} requires role ${tool.capability} (you have ${ctx.userRole})`,
    );
  }

  /* 3. Action-tool confirmation gate. Action tools MUST set
        requiresConfirmation = true so we never silently mutate on
        the first turn. */
  if (tool.requiresConfirmation) {
    return failure(
      "needs_confirmation",
      `tool ${tool.name} mutates state and needs explicit confirmation`,
    );
  }

  /* 4. Execute. Tool handlers should never throw — but we guard. */
  try {
    return await tool.handler(parsed.data, ctx);
  } catch (err) {
    return failure(
      "internal",
      `tool ${tool.name} threw: ${(err as Error)?.message ?? "unknown"}`,
    );
  }
}

function failure(
  code: ToolFailure["code"],
  message: string,
): ToolFailure {
  return { ok: false, code, message };
}
