/**
 * MCP (Model Context Protocol) scanner — types.
 *
 * STATIC analysis only: we never connect to an MCP server (no outbound MCP
 * client, no live tool calls), so our core gains zero new attack surface. The
 * scanner reads a client's MCP CONFIG (the servers they have wired up) and,
 * optionally, a tool MANIFEST they exported (tools/list output), and flags the
 * documented MCP threat classes. Each configured server is also registered into
 * the AI Surface Inventory as kind "mcp_server" so MCP usage shows up alongside
 * every other AI touchpoint.
 */
import type { AiSurfaceRisk } from "../types";

/** One configured MCP server (a normalized union of the stdio + HTTP shapes). */
export interface McpServerConfig {
  name: string;
  /** stdio transport: the launch command + args (+ env). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport: the server URL (+ headers, e.g. an auth token). */
  url?: string;
  headers?: Record<string, string>;
}

/** One tool a server exposes (from tools/list). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** The MCP threat classes this scanner detects. */
export type McpFindingClass =
  | "unpinned_server" // supply-chain / rug-pull: an unversioned remote package launch
  | "secret_in_config" // a hardcoded credential in env/args/headers
  | "unauthenticated_http" // an HTTP server with no auth header configured
  | "dangerous_command" // the server launches a shell / arbitrary code
  | "tool_poisoning" // injection / hidden instructions in a tool description
  | "hidden_unicode" // zero-width / bidi characters hiding instructions
  | "tool_shadowing" // duplicate tool names (one server can shadow another's tool)
  | "dangerous_capability"; // a tool exposes exec/shell/delete with no constraint

export interface McpFinding {
  server: string;
  klass: McpFindingClass;
  severity: AiSurfaceRisk;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface McpScanInput {
  workspaceId: string;
  /** A label for this MCP environment (e.g. a repo or workstation id). */
  target: string;
  servers: McpServerConfig[];
  /** Optional exported tool manifests, keyed by server name. */
  toolsByServer?: Record<string, McpToolDef[]>;
}

export interface McpScanResult {
  target: string;
  servers: number;
  findings: McpFinding[];
  /** Inventory rows written (one mcp_server surface per configured server). */
  written: number;
  bySeverity: Record<string, number>;
  byClass: Record<string, number>;
}
