/**
 * Agent↔connection binding API (migration 183).
 *
 * Lets an operator build "a Salesforce agent", "a Jira agent", etc. by
 * associating one or more reusable workspace connector credentials with an
 * agent principal. The connection itself stays workspace-scoped + reusable —
 * this route only manages the association layer (instinct_agent_connections).
 *
 * Capability: settings.manage_team (the same gate that manages agents +
 * connector credentials). Workspace-scoped to the caller.
 *
 * GET    /api/admin/agents/[id]/connections
 *   -> { bound: Array<{connectorName, baseUrl, authType}>,
 *        available: Array<{connectorName, baseUrl, authType}> }
 *      bound     = this agent's bound connections joined to their details.
 *      available = active workspace connections NOT yet bound to this agent.
 * POST   /api/admin/agents/[id]/connections   body { connectorName }
 *   -> 200 { ok: true, bound: [...] } (the refreshed bound list). 400 if missing.
 * DELETE /api/admin/agents/[id]/connections   body { connectorName }
 *   -> 200 { ok: true }. 400 if missing.
 *
 * Both mutations are hash-chained in the audit log (best-effort), action
 * "agent.connection_bound" / "agent.connection_unbound", resourceType
 * "agent_connection", resourceId = the agent id.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { listConnectorCredentials } from "@/lib/assistant/connectors/credentials";
import {
  bindAgentConnection,
  unbindAgentConnection,
  listAgentConnectionNames,
} from "@/lib/agents/connections/store";

interface BoundConnection {
  connectorName: string;
  baseUrl: string;
  authType: string;
}

/**
 * Join the agent's bound connector names with the workspace's credential
 * details. Connections without a matching active credential row are dropped
 * (env-fallback-only / disabled rows have no detail to surface).
 */
async function resolveBound(
  workspaceId: string,
  agentId: string,
): Promise<BoundConnection[]> {
  const [boundNames, creds] = await Promise.all([
    listAgentConnectionNames(workspaceId, agentId),
    listConnectorCredentials(workspaceId),
  ]);
  const nameSet = new Set(boundNames);
  return creds
    .filter((c) => nameSet.has(c.connectorName))
    .map((c) => ({
      connectorName: c.connectorName,
      baseUrl: c.baseUrl,
      authType: c.authType,
    }));
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  const workspaceId = auth.user.workspaceId ?? "default";

  const [boundNames, creds] = await Promise.all([
    listAgentConnectionNames(workspaceId, agentId),
    listConnectorCredentials(workspaceId),
  ]);
  const boundSet = new Set(boundNames);

  const bound: BoundConnection[] = [];
  const available: BoundConnection[] = [];
  for (const c of creds) {
    const detail: BoundConnection = {
      connectorName: c.connectorName,
      baseUrl: c.baseUrl,
      authType: c.authType,
    };
    if (boundSet.has(c.connectorName)) {
      bound.push(detail);
    } else if (c.isActive) {
      /* available = active workspace connections NOT bound to this agent. */
      available.push(detail);
    }
  }

  return NextResponse.json({ bound, available });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  const workspaceId = user.workspaceId ?? "default";

  let body: { connectorName?: string };
  try {
    body = (await req.json()) as { connectorName?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const connectorName = body.connectorName;
  if (!connectorName || typeof connectorName !== "string") {
    return NextResponse.json(
      { error: "connectorName required" },
      { status: 400 },
    );
  }

  const created = await bindAgentConnection({
    workspaceId,
    agentId,
    connectorName,
    createdBy: user.id,
  });

  /* Hash-chain the association change. Best-effort: a failed audit must never
     fail the bind. Only audit a real state change (created === true). */
  if (created) {
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "agent.connection_bound",
      resourceType: "agent_connection",
      resourceId: agentId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      afterState: { connector_name: connectorName },
    }).catch((e) => console.warn("[audit]", (e as Error).message));
  }

  const bound = await resolveBound(workspaceId, agentId);
  return NextResponse.json({ ok: true, bound });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  const workspaceId = user.workspaceId ?? "default";

  let body: { connectorName?: string };
  try {
    body = (await req.json()) as { connectorName?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const connectorName = body.connectorName;
  if (!connectorName || typeof connectorName !== "string") {
    return NextResponse.json(
      { error: "connectorName required" },
      { status: 400 },
    );
  }

  const removed = await unbindAgentConnection(
    workspaceId,
    agentId,
    connectorName,
    user.id,
  );

  if (removed) {
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "agent.connection_unbound",
      resourceType: "agent_connection",
      resourceId: agentId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      beforeState: { connector_name: connectorName },
    }).catch((e) => console.warn("[audit]", (e as Error).message));
  }

  return NextResponse.json({ ok: true });
}
