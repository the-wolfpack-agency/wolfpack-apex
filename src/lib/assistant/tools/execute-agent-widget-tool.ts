/**
 * execute_agent_widget: open the agent control plane inside chat.
 *
 * Typing "run an agent", "execute an agent", "launch agent Aria", or "agent
 * control panel" returns an inline widget: an agent picker + the task template
 * (Objective + Success criteria required, Context optional). Submitting runs the
 * chosen agent through the SAME governed task API the detail page uses, so the
 * work is executed under the agent's own identity, gated by OGIAM and the
 * constitution.
 *
 * This is the "open the form" intent, distinct from delegate_to_agent (which
 * executes a one-line instruction immediately). Delegate claims "Agent1 <do X>";
 * this claims "run/execute/launch ... agent", which delegate never matches, so
 * the two do not collide.
 *
 * Authorization mirrors delegate_to_agent: only a manager-or-above may open the
 * control plane (the same rank that administers agents). The task API then
 * re-enforces settings.manage_team on submit, so this is defense in depth.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { listAgents } from "@/lib/agents/store";
import { canInvokeTool } from "./gate";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  ExecuteAgentOption,
  ExecuteAgentWidgetSpec,
} from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({ agentName: z.string().max(120).optional() });
type Params = z.infer<typeof ParamSchema>;

interface ExecuteAgentData {
  kind: "execute_agent";
  agentCount: number;
}

const RUN_AGENT_RE =
  /^(?:run|execute|launch|start|kick\s*off)\s+(?:the\s+|an?\s+)?agent\b\s*(.*)$/i;
const PANEL_RE =
  /^(?:open\s+)?(?:the\s+)?agent\s+control\s+(?:panel|plane)[\s.?!]*$/i;

export function matchExecuteAgentIntent(message: string): Params | null {
  const t = (message ?? "").trim();
  if (!t) return null;
  if (PANEL_RE.test(t)) return {};
  const m = RUN_AGENT_RE.exec(t);
  if (!m) return null;
  let tail = (m[1] ?? "").trim().replace(/^(?:named|called)\s+/i, "");
  // Drop a trailing task clause ("... to draft the brief") — the widget collects
  // the actual task, so only a leading agent-name hint is kept.
  const toIdx = tail.search(/\bto\s+\S/i);
  if (toIdx === 0) tail = "";
  else if (toIdx > 0) tail = tail.slice(0, toIdx).trim();
  return tail ? { agentName: tail } : {};
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "").trim();
}

export const executeAgentWidgetTool: ToolDef<Params, ExecuteAgentData> = {
  name: "execute_agent_widget",
  description:
    "Open the agent control plane in chat: an agent picker plus the task template (objective + success criteria required, context optional). Use when the user says 'run an agent', 'execute an agent', 'launch agent <name>', or 'agent control panel'. Submitting runs the agent through the governed task API.",
  paramSchema: ParamSchema,
  // Any authenticated user may ATTEMPT; the handler enforces manager-or-above,
  // and the task API re-enforces settings.manage_team on submit.
  capability: "*",
  requiresConfirmation: false,
  // A human control surface. An executing agent must never open it.
  humanOnly: true,
  matchIntent: matchExecuteAgentIntent,
  async handler(params, ctx): Promise<ToolResult<ExecuteAgentData>> {
    if (!canInvokeTool(ctx.userRole, "manager")) {
      return {
        ok: false,
        code: "capability",
        message: "Only a manager or above can run agents.",
      };
    }

    const workspaceId = ctx.workspaceId ?? ctx.agentPrincipal?.workspaceId ?? "";
    let agents: ExecuteAgentOption[] = [];
    if (workspaceId) {
      const roster = await listAgents(workspaceId);
      agents = roster
        .map((a) => ({ id: a.id, name: a.name, state: a.state }))
        // Active agents first so the default selection can run immediately.
        .sort((x, y) => Number(y.state === "active") - Number(x.state === "active"));
    }

    let preselectedAgentId: string | undefined;
    if (params.agentName) {
      const wanted = normalizeName(params.agentName);
      preselectedAgentId = agents.find((a) => normalizeName(a.name) === wanted)?.id;
    }

    const spec: ExecuteAgentWidgetSpec = {
      kind: "execute_agent",
      agents,
      preselectedAgentId,
      submitUrlTemplate: "/api/admin/agents/{id}/tasks",
    };

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "execute_agent",
      agent_count: agents.length,
      preselected: Boolean(preselectedAgentId),
    });

    const answer =
      agents.length === 0
        ? "No agents are onboarded in this workspace yet. Onboard one under Admin -> Agents, then you can run tasks from here."
        : "Pick an agent and fill in the task template to run it. Objective and success criteria are required.";

    return {
      ok: true,
      data: { kind: "execute_agent", agentCount: agents.length },
      answer,
      widget: spec,
    };
  },
};

registerTool(executeAgentWidgetTool);
