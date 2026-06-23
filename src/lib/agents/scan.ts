/**
 * Agent self-onboarding scan.
 *
 * When an agent first logs in it introspects the platform to learn how to use
 * it. This is deterministic discovery from ground-truth manifests, not crawling
 * or guessing: it reads the tool registry (the machine-readable list of every
 * action the assistant can take) and the agent's role capabilities, and produces
 * a system model marking exactly which tools the agent is permitted to invoke.
 * The "allowed" flag uses the SAME gate the dispatcher uses (canInvokeTool), so
 * the model can never claim a capability the runtime would refuse.
 *
 * The model is the agent's job description plus the platform manual, scoped to
 * its permissions. It is stored (scan-store) so later agents can inherit it
 * instead of re-paying the exploration cost.
 */

import { getTools } from "@/lib/assistant/tools/registry";
import { canInvokeTool } from "@/lib/assistant/tools/gate";
import { capabilitiesForRole } from "@/lib/auth/role-capabilities";
import { AGENT_OPERATIONS } from "@/lib/agents/operations/registry";

/** Bump when the scan shape or discovery logic changes. */
export const AGENT_SCAN_VERSION = "agent-scan-2026-06-24.2";

export interface DiscoveredTool {
  name: string;
  description: string;
  /** The minimum role the tool requires ("*" = any). */
  capability: string;
  isMutation: boolean;
  /** True when this agent's role may invoke the tool. */
  allowed: boolean;
}

/**
 * A declarative platform OPERATION the agent has discovered (the operation
 * registry). Unlike a tool, an operation is invoked ON THE OWNER'S BEHALF via
 * the on-behalf delegation token, with no per-function handler code. The scan
 * reports it so the agent's system model shows it KNOWS the operation, with an
 * `allowed` flag from the SAME gate the dispatcher + executor use.
 */
export interface DiscoveredOperation {
  id: string;
  summary: string;
  /** The minimum role the operation requires ("*" = any). */
  capability: string;
  /** True when this agent's role may invoke the operation. */
  allowed: boolean;
}

export interface AgentSystemModel {
  scanVersion: string;
  agentId: string;
  role: string;
  workspaceId: string;
  /** The agent's effective capabilities, from its role. */
  capabilities: string[];
  /** Every tool, each marked allowed/not for this agent. */
  tools: DiscoveredTool[];
  /** Every declarative platform operation, each marked allowed/not. */
  operations: DiscoveredOperation[];
  summary: {
    toolCount: number;
    allowedToolCount: number;
    mutationCount: number;
    capabilityCount: number;
    /** Number of declarative operations the agent discovered. */
    operationCount: number;
  };
}

export interface ScanPrincipal {
  agentId: string;
  role: string;
  workspaceId: string;
}

/**
 * Build the agent's system model. Pure: reads the in-process registry and the
 * role capability map, no IO, so it is deterministic and unit testable.
 */
export function runSelfOnboardingScan(principal: ScanPrincipal): AgentSystemModel {
  const tools: DiscoveredTool[] = getTools().map((t) => ({
    name: t.name,
    description: t.description,
    capability: t.capability,
    isMutation: Boolean(t.requiresConfirmation),
    allowed: canInvokeTool(principal.role, t.capability),
  }));
  // Stable order so the model and its hash are reproducible.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  // Declarative platform operations the agent now KNOWS it can invoke (e.g.
  // create_qr_code). `allowed` uses the SAME gate as the tools + the dispatcher
  // so the model can never claim an operation the runtime would refuse.
  const operations: DiscoveredOperation[] = AGENT_OPERATIONS.map((op) => ({
    id: op.id,
    summary: op.summary,
    capability: op.capability,
    allowed: canInvokeTool(principal.role, op.capability),
  }));
  operations.sort((a, b) => a.id.localeCompare(b.id));

  const capabilities = [...capabilitiesForRole(principal.role)].sort();
  const allowed = tools.filter((t) => t.allowed);

  return {
    scanVersion: AGENT_SCAN_VERSION,
    agentId: principal.agentId,
    role: principal.role,
    workspaceId: principal.workspaceId,
    capabilities,
    tools,
    operations,
    summary: {
      toolCount: tools.length,
      allowedToolCount: allowed.length,
      mutationCount: tools.filter((t) => t.isMutation).length,
      capabilityCount: capabilities.length,
      operationCount: operations.length,
    },
  };
}
