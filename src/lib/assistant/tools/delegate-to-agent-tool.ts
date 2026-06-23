/**
 * delegate_to_agent: let a human direct an onboarded agent to do real work.
 *
 * Typing "Agent1 add a task titled Doctors Appointment" in the assistant
 * makes that agent execute the workflow AS A USER WOULD, governed end to end
 * by OGIAM. This is the capstone proof that an onboarded agent has learned the
 * whole system: the human states the goal in plain language, the agent runs a
 * bounded, per-step authorized plan under its own principal, and the human sees
 * the outcome inline.
 *
 * Security boundary (this can drive a privileged agent, so authorization is
 * mandatory and lives in the HANDLER, not just the dispatcher):
 *   - The tool's capability is "*", so any authenticated user can ATTEMPT a
 *     delegation. The handler then enforces WHO may direct WHICH agent: only
 *     the agent's accountable human owner, or a manager-or-above role, may do
 *     so. A low-privilege user cannot weaponize a high-privilege agent.
 *   - The agent must be `active`. A paused / revoked agent is refused.
 *   - Every step the agent then runs is independently gated by OGIAM in enforce
 *     mode inside the executor; a blocked step escalates to the owner. We do NOT
 *     double-gate the human with requiresConfirmation; the agent's own
 *     per-step gate is the control.
 *
 * Intent: anchored on an explicit agent-direction lead word so bare phrasings
 * like "add a task titled X" (the user's OWN tools) are never swallowed.
 * Registered BEFORE the generic search / widget tools and BEFORE who_is so an
 * explicit "Agent1 ..." direction wins the cascade.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { listAgents } from "@/lib/agents/store";
import { createTask, completeTask } from "@/lib/agents/tasks/store";
import { runAgentTask } from "@/lib/agents/tasks/executor";
import { canInvokeTool } from "./gate";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  agentName: z.string().min(1).max(120),
  instruction: z.string().min(1).max(2000),
});
type Params = z.infer<typeof ParamSchema>;

export interface DelegateResult {
  agentId: string;
  taskId: string;
  status: string;
  steps: number;
  inherited: boolean;
}

/**
 * Three explicit agent-direction forms, each capturing <name> and
 * <instruction>. Every pattern requires a direction LEAD so a bare tool phrase
 * ("add a task titled X", "search Acme") can never claim this tool:
 *
 *   1. "Agent <name> <instruction>" / "Agent<name> <instruction>"
 *      The literal lead word "agent" is PART of the name ("Agent1", "Agent 1",
 *      "agent1" all refer to the same agent, since name normalization collapses
 *      the spacing). The instruction group is required and non-empty so "agent" with
 *      no following work is not a delegation.
 *   2. "tell|ask|have|direct <name> to <instruction>"
 *      A direction verb + name + the literal "to" + a rest.
 *   3. "@<name> <instruction>"
 *      An @-mention lead + a name token + a rest.
 *
 * For form 1 the captured name keeps the "agent" lead and the suffix token, so
 * normalizeName turns "Agent1" / "Agent 1" / "agent1" into the same key.
 */
const LEAD_AGENT_RE =
  /^(agent\s*[a-z0-9][a-z0-9 _-]*?)\s+(?=\S)(.+)$/i;
const DIRECT_VERB_RE =
  /^(?:tell|ask|have|direct)\s+([a-z0-9][a-z0-9 _-]*?)\s+to\s+(?=\S)(.+)$/i;
const MENTION_RE = /^@\s*([a-z0-9][a-z0-9 _-]*?)\s+(?=\S)(.+)$/i;

export function matchDelegateIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;

  for (const re of [LEAD_AGENT_RE, DIRECT_VERB_RE, MENTION_RE]) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const agentName = (m[1] ?? "").trim();
    const instruction = (m[2] ?? "").trim();
    if (!agentName || !instruction) continue;
    return { agentName, instruction };
  }
  return null;
}

/** Normalize an agent name for tolerant matching: lowercase, collapse the
 *  whitespace/separators so "Agent1", "Agent 1", "agent-1" all compare equal. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "").trim();
}

/** Roles that may direct any agent in the workspace regardless of ownership.
 *  Reuses the SAME role-rank gate the tool dispatcher and agent self-scan use
 *  (canInvokeTool / TOOL_ROLE_LEVEL); no second hardcoded role list. A role at
 *  or above "manager" can invoke a tool gated at the "manager" level, which is
 *  exactly the manager-or-above check we want. */
function isManagerOrAbove(role: string): boolean {
  return canInvokeTool(role, "manager");
}

function renderSteps(steps: DelegateRunStep[]): string {
  if (steps.length === 0) return "";
  const lines = steps.map(
    (s) => `- ${s.instruction} -> ${s.outcome}`,
  );
  return `\n${lines.join("\n")}`;
}

interface DelegateRunStep {
  instruction: string;
  outcome: string;
}

export const delegateToAgentTool: ToolDef<Params, DelegateResult> = {
  name: "delegate_to_agent",
  description:
    "Direct an onboarded agent to do real work, e.g. 'Agent1 add a task titled Doctors Appointment' or 'tell Scout to log my hours'. The named agent runs the instruction as a governed, per-step OGIAM-authorized plan under its own principal. Only the agent's owner or a manager-or-above may direct it.",
  paramSchema: ParamSchema,
  // Any authenticated user may ATTEMPT; the handler enforces who may direct
  // which agent. The agent's own per-step OGIAM gate is the execution control,
  // so we do not double-gate the human with a confirmation prompt.
  capability: "*",
  requiresConfirmation: false,
  matchIntent: matchDelegateIntent,
  async handler(params, ctx): Promise<ToolResult<DelegateResult>> {
    const workspaceId =
      ctx.workspaceId ?? ctx.agentPrincipal?.workspaceId ?? "";
    if (!workspaceId) {
      return {
        ok: false,
        code: "capability",
        message: "No workspace in context.",
      };
    }

    const agents = await listAgents(workspaceId);
    const wanted = normalizeName(params.agentName);
    const agent = agents.find((a) => normalizeName(a.name) === wanted);

    if (!agent) {
      const available = agents.map((a) => a.name);
      const list =
        available.length > 0
          ? ` Available agents: ${available.join(", ")}.`
          : " No agents are onboarded in this workspace yet.";
      return {
        ok: false,
        code: "no_match",
        message: `No agent named "${params.agentName}" found.${list}`,
      };
    }

    if (agent.state !== "active") {
      return {
        ok: false,
        code: "capability",
        message: `Agent ${agent.name} is ${agent.state} and cannot act. See its profile at /admin/agents/${agent.id}.`,
      };
    }

    // Authorization boundary: only the agent's accountable owner, or a
    // manager-or-above role, may direct this agent. This stops a low-privilege
    // user from weaponizing a high-privilege agent.
    const isOwner = ctx.userId === agent.ownerUserId;
    const authorized = isOwner || isManagerOrAbove(ctx.userRole);
    if (!authorized) {
      return {
        ok: false,
        code: "capability",
        message: `Only the owner of agent ${agent.name} or a manager may direct it.`,
      };
    }

    const instruction = params.instruction;

    // Mirror the canonical create + run + complete wiring in
    // src/app/api/agents/run-tasks/route.ts: we createTask explicitly here
    // (instead of the queue), then run it through the governed executor under
    // the agent's own identity, then persist the final state.
    const task = await createTask({
      agentId: agent.id,
      workspaceId,
      assignedBy: ctx.userId,
      assignedByRole: ctx.userRole,
      goal: instruction,
    });

    const run = await runAgentTask({
      id: task.id,
      goal: instruction,
      agentId: agent.id,
      role: agent.role,
      workspaceId,
      ownerUserId: agent.ownerUserId,
    });

    await completeTask(task.id, run.status, run.steps, run.resultSummary);

    trackEvent("agent.delegated", agent.id, "agent", {
      workspace_id: workspaceId,
      requested_by: ctx.userId,
      requester_role: ctx.userRole,
      goal_len: instruction.length,
      status: run.status,
      steps: run.steps.length,
      inherited: run.inherited,
    });

    const renderSteppable: DelegateRunStep[] = run.steps.map((s) => ({
      instruction: s.instruction,
      outcome: s.outcome,
    }));

    let answer: string;
    if (run.status === "succeeded") {
      answer = `Agent ${agent.name} completed: ${run.resultSummary}${renderSteps(renderSteppable)}`;
    } else if (run.status === "blocked") {
      const blockedStep = run.steps.find((s) => s.outcome === "blocked");
      const where = blockedStep
        ? ` The step held for approval was: ${blockedStep.instruction}.`
        : "";
      answer = `Agent ${agent.name} reached a step that OGIAM held for owner approval, so its owner was notified to review it.${where} ${run.resultSummary}`.trim();
    } else {
      answer = `Agent ${agent.name} could not finish: ${run.resultSummary}${renderSteps(renderSteppable)}`;
    }

    return {
      ok: true,
      data: {
        agentId: agent.id,
        taskId: task.id,
        status: run.status,
        steps: run.steps.length,
        inherited: run.inherited,
      },
      answer,
    };
  },
};

registerTool(delegateToAgentTool);
