/**
 * MCP scan orchestrator: run the detectors over a client's MCP config + tool
 * manifests, register each configured server into the AI Surface Inventory as a
 * kind "mcp_server" touchpoint (risk = its worst finding), and return the full
 * findings list. Static only - no MCP connection is made.
 */
import { upsertSurfaces } from "../store";
import { scanServer } from "./detect";
import type { AiSurface, AiSurfaceRisk } from "../types";
import type { McpScanInput, McpScanResult, McpFinding } from "./types";

const SEV_ORDER: Record<AiSurfaceRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function worstSeverity(findings: McpFinding[]): AiSurfaceRisk {
  let w: AiSurfaceRisk = "low";
  for (const f of findings) if (SEV_ORDER[f.severity] > SEV_ORDER[w]) w = f.severity;
  return w;
}

export async function runMcpScan(input: McpScanInput): Promise<McpScanResult> {
  const allFindings: McpFinding[] = [];
  const surfaces: AiSurface[] = [];

  for (const s of input.servers) {
    const tools = input.toolsByServer?.[s.name];
    const findings = scanServer(s, tools);
    allFindings.push(...findings);
    surfaces.push({
      kind: "mcp_server",
      provider: "mcp",
      location: s.name,
      governed: false,
      risk: findings.length ? worstSeverity(findings) : "low",
      evidence: {
        transport: s.url ? "http" : "stdio",
        tools: tools?.length ?? 0,
        findingCount: findings.length,
        // The findings ride durably in the inventory row (JSONB) so no data is
        // lost; they are also emitted as analytics events by the route.
        findings: JSON.stringify(findings.map((f) => ({ klass: f.klass, severity: f.severity, title: f.title }))),
      },
    });
  }

  const written = await upsertSurfaces(input.workspaceId, input.target, surfaces);

  const bySeverity: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const f of allFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byClass[f.klass] = (byClass[f.klass] ?? 0) + 1;
  }

  return {
    target: input.target,
    servers: input.servers.length,
    findings: allFindings,
    written,
    bySeverity,
    byClass,
  };
}
