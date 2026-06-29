/**
 * POST /api/admin/ai-surfaces/mcp-scan — static MCP risk scan.
 *
 * Body: { target, servers: McpServerConfig[], toolsByServer?: { [name]: McpToolDef[] } }.
 * Statically analyzes a client's MCP configuration + (optionally) their exported
 * tool manifests for the documented MCP threat classes (tool poisoning, unpinned
 * supply-chain servers, secrets in config, unauthenticated endpoints, dangerous
 * capabilities, hidden-unicode instructions), registers each server into the AI
 * Surface Inventory as kind "mcp_server", and returns the findings.
 *
 * NO MCP CONNECTION is made - the caller supplies the config/manifest, so our
 * core never speaks MCP or reaches out to a server. Capability:
 * settings.manage_team. Read-derived (audit-allowlisted). Emits mcp.scan_completed
 * + one mcp.finding_detected per finding (capped) so the learning loop sees the
 * MCP threat distribution.
 *
 * Returns: 200 { result } | 400 (bad body) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { runMcpScan } from "@/lib/ai-surface/mcp/scan";
import type { McpServerConfig, McpToolDef } from "@/lib/ai-surface/mcp/types";

const MAX_SERVERS = 200;
const MAX_FINDING_EVENTS = 100;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { target?: unknown; servers?: unknown; toolsByServer?: unknown };
  const target = typeof b.target === "string" ? b.target.trim() : "";
  if (!target) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }
  if (!Array.isArray(b.servers) || b.servers.length === 0) {
    return NextResponse.json({ error: "servers must be a non-empty array" }, { status: 400 });
  }
  if (b.servers.length > MAX_SERVERS) {
    return NextResponse.json({ error: `too many servers (max ${MAX_SERVERS})` }, { status: 400 });
  }
  // Keep only well-formed server entries (each needs a name).
  const servers = b.servers.filter(
    (s): s is McpServerConfig => !!s && typeof (s as { name?: unknown }).name === "string",
  );
  if (servers.length === 0) {
    return NextResponse.json({ error: "each server needs a string name" }, { status: 400 });
  }
  const toolsByServer =
    b.toolsByServer && typeof b.toolsByServer === "object"
      ? (b.toolsByServer as Record<string, McpToolDef[]>)
      : undefined;

  const workspaceId = auth.user.workspaceId ?? "default";
  const result = await runMcpScan({ workspaceId, target, servers, toolsByServer });

  trackEvent("mcp.scan_completed", auth.user.id, auth.user.role, {
    target,
    servers: result.servers,
    findings: result.findings.length,
    critical: result.bySeverity.critical ?? 0,
    high: result.bySeverity.high ?? 0,
  });
  for (const f of result.findings.slice(0, MAX_FINDING_EVENTS)) {
    trackEvent("mcp.finding_detected", auth.user.id, auth.user.role, {
      server: f.server,
      class: f.klass,
      severity: f.severity,
    });
  }

  return NextResponse.json({ result });
}
