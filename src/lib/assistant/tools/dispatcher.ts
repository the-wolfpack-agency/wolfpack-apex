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
import { resolveEnforcementMode } from "@/lib/ogiam/enforcement-policy";
import { recordActionOutcome } from "@/lib/ogiam/ledger";
import { ingestAgentAction } from "@/lib/agents/audit/brain-ingest";
import { createPendingApproval } from "@/lib/agents/approvals/store";
import { notify } from "@/lib/notifications/in-app";
import type { OgiamDecision } from "@/lib/ogiam/types";
import { canInvokeTool } from "./gate";
import { getTools, getToolByName } from "./registry";
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

/**
 * Run ONE named tool with explicit parameters, through the same pipeline a
 * chat message takes.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND PATH
 *
 * tryDispatchTool starts from a sentence and guesses which tool was meant. A
 * routine (src/lib/assistant/routines) already knows: its steps name a tool and
 * carry validated parameters, and re-phrasing them back into English so the
 * intent regexes could re-derive the answer would be a guess inserted between
 * two certainties -- and the wrong tool would run.
 *
 * So this skips the MATCHING and nothing else. Validation, the OGIAM decision,
 * the capability gate, confirmation for mutations, the ledger, the approval
 * queue and the analytics are all runOneTool, unchanged and shared. A routine
 * therefore cannot do anything its owner could not do one message at a time,
 * which is the property that lets chains be governed by the controls that
 * already exist rather than by new ones written alongside them.
 *
 * Returns null for an unknown tool name so a stale saved routine degrades to a
 * reported failure instead of throwing inside a run.
 */
export async function dispatchToolByName(
  name: string,
  params: unknown,
  ctx: ToolContext,
): Promise<ToolDispatchResult | null> {
  const tool = getToolByName(name);
  if (!tool) return null;

  /* The same two principal rules the matching path enforces. A routine must not
     become the way an agent reaches a human-only tool, or a human reaches an
     agent-only one. */
  if (ctx.agentPrincipal && tool.humanOnly) return null;
  if (!ctx.agentPrincipal && tool.agentOnly) return null;

  const started = Date.now();
  const result = await runOneTool(tool, params, ctx);
  const durationMs = Date.now() - started;

  const wid = ctx.workflowId;
  trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
    tool: tool.name,
    success: result.ok,
    code: result.ok ? "ok" : result.code,
    duration_ms: durationMs,
    /* Distinguishes a step of a chain from somebody typing, so the learning
       loop can tell which tools are used because they were CHOSEN and which
       are used because a routine includes them. */
    source: "routine",
    ...(wid ? { workflow_id: wid } : {}),
  });
  if (!result.ok) {
    trackEvent("assistant.tool_failed", ctx.userId, ctx.userRole, {
      tool: tool.name,
      code: result.code,
      message: result.message.slice(0, 200),
      source: "routine",
      ...(wid ? { workflow_id: wid } : {}),
    });
  } else {
    trackEvent("assistant.tool_succeeded", ctx.userId, ctx.userRole, {
      tool: tool.name,
      duration_ms: durationMs,
      source: "routine",
      ...(wid ? { workflow_id: wid } : {}),
    });
  }

  return { tool: tool.name, result, durationMs };
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
  /* Resolve the enforcement posture for this (workspace, capability). A
     per-capability admin override wins; with NO override this returns the prior
     hardcoded default (agents enforce, the human assistant monitors), so the gate
     behaves exactly as before until an admin sets a posture. Fail-safe: any DB
     error resolves to that same default, never throws. */
  const gateWorkspaceId = agent ? agent.workspaceId : ctx.workspaceId ?? "default";
  const mode = await resolveEnforcementMode({
    workspaceId: gateWorkspaceId,
    capability: tool.capability,
    isAgent: Boolean(agent),
  });
  /* Held across the gate so an agent OUTCOME can be linked to its decision seq
     after execution. Absent when the ledger write was skipped/failed. */
  let decision: OgiamDecision | null = null;
  try {
    decision = await authorize({
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
      mode,
    });
    if (agent && decision.unauditable) {
      // Fail closed: the action could not be written to the tamper-evident
      // ledger, so it must not run. The ledger is unavailable, so this block can
      // only be captured off-ledger (best effort) - but the action is stopped.
      trackEvent("ogiam.action_blocked_unauditable", agent.agentId, agent.role, {
        agent_id: agent.agentId,
        workspace_id: agent.workspaceId,
        tool: tool.name,
        capability: tool.capability,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      // HUMAN ALERTING: a fail-closed block is a security event the agent's owner
      // must see (an agent tried an action that could not be audited). Best effort.
      await alertAgentBlock(agent, tool.name, "action could not be audited (fail-closed)");
      return failure(
        "internal",
        "blocked: action could not be audited (fail-closed; no audit, no action)",
      );
    }
    if (agent && decision.enforced && decision.wouldBlock) {
      // HUMAN ALERTING: the OGIAM gate refused an autonomous agent action in
      // enforce mode. The owner must see the block, not just the ledger row.
      // Only fires for an AGENT principal in ENFORCE mode (decision.enforced) —
      // a human in monitor mode is never alerted. Best effort.
      await alertAgentBlock(
        agent,
        tool.name,
        `OGIAM ${decision.intendedOutcome}: ${decision.reason} (rule ${decision.ruleId})`,
      );
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
    /* For a governed AGENT, capture the proposed mutation as a pending approval
       so an owner/admin can review and execute the EXACT action later. The OGIAM
       gate has already allowed it; this is the human-in-the-loop confirmation.
       Best-effort: if capture fails the action simply stays blocked (no mutation),
       and the human path is unchanged (no capture, same needs_confirmation). */
    const ap = ctx.agentPrincipal;
    if (ap) {
      await createPendingApproval({
        workspaceId: ap.workspaceId,
        agentId: ap.agentId,
        ownerUserId: ap.ownerUserId,
        tool: tool.name,
        params: parsed.data as Record<string, unknown>,
        capability: tool.capability,
        decisionSeq: decision?.recordedSeq ?? null,
      });
    }
    return failure(
      "needs_confirmation",
      `tool ${tool.name} mutates state and needs explicit confirmation`,
    );
  }

  /* 4. Execute. Tool handlers should never throw — but we guard. */
  const startedExec = Date.now();
  let result: ToolResult<R>;
  try {
    result = await tool.handler(parsed.data, ctx);
  } catch (err) {
    result = failure(
      "internal",
      `tool ${tool.name} threw: ${(err as Error)?.message ?? "unknown"}`,
    );
  }
  const execDurationMs = Date.now() - startedExec;

  /* 5. Record the action OUTCOME (the RESULT half of the audit trail) for a
        GOVERNED AGENT principal only, linked to the decision seq. The decision
        captured the redacted INPUT; this captures the redacted RESULT, so the
        per-agent trail is true prompt-to-response. Both the outcome write and
        the Brain summary are best effort and MUST NEVER throw into dispatch:
        the human path is unchanged (no agent → skip), and an outcome/Brain
        failure can never break dispatch or the gate. */
  if (agent && typeof decision?.recordedSeq === "number") {
    const code = result.ok ? "ok" : result.code;
    const resultText = result.ok ? result.answer : result.message;
    await recordActionOutcome({
      workspaceId: agent.workspaceId,
      decisionSeq: decision.recordedSeq,
      agentId: agent.agentId,
      ok: result.ok,
      code,
      resultRedacted: resultText,
      durationMs: execDurationMs,
    }).catch(() => {
      /* swallowed: outcome persistence never breaks dispatch */
    });
    await ingestAgentAction({
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      tool: tool.name,
      outcome: code,
      ruleId: decision.ruleId,
      resultRedacted: resultText,
    }).catch(() => {
      /* swallowed: Brain ingest never breaks dispatch */
    });
  }

  return result;
}

function failure(
  code: ToolFailure["code"],
  message: string,
): ToolFailure {
  return { ok: false, code, message };
}

/**
 * HUMAN ALERTING: notify an agent's owner that an autonomous action was blocked
 * by the OGIAM gate in enforce mode. Reuses the in-app notification path (same
 * idiom as the drift store's auto-pause notify); the notification row IS the
 * persisted learning signal (notify emits system.notification_created).
 *
 * Strictly best effort: a notify failure MUST NOT throw into dispatch and must
 * never break the block (the action is already stopped). Only ever called from
 * the AGENT enforce-block branches, so the gating (agent principal + enforce
 * mode) is guaranteed at the call site.
 */
async function alertAgentBlock(
  agent: NonNullable<ToolContext["agentPrincipal"]>,
  toolName: string,
  reason: string,
): Promise<void> {
  try {
    await notify({
      userId: agent.ownerUserId,
      category: "security",
      priority: "high",
      title: "Agent action blocked by the governance gate",
      body: `Agent ${agent.agentId} was blocked from running ${toolName}: ${reason}.`,
      actionUrl: `/admin/agents/${agent.agentId}`,
      actionLabel: "Review agent",
      source: "agent_action_blocked",
      sourceId: `${agent.agentId}:${toolName}`,
      metadata: { agent_id: agent.agentId, tool: toolName, reason },
      dedup: true,
    });
  } catch {
    /* notification is best effort; the block already stands */
  }
}
