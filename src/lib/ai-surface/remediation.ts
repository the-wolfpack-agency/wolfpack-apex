/**
 * AI Surface remediation guidance — deterministic "here is how to govern this"
 * for every discovered touchpoint.
 *
 * Detection without a fix is a dead end: an inventory of ungoverned AI is only a
 * sale if the prospect can see the path to closing each gap. This module turns
 * one AiSurface into concrete, copy-pasteable steps for routing it through the
 * OGIAM gate. It is a PURE FUNCTION of (kind + provider) — NOT an LLM call — so
 * the same surface always yields the same guidance: reproducible, testable, and
 * free. The gate snippet mirrors the bring-your-own-agent gate-as-a-service shape
 * (POST /api/gate/authorize), so the guidance points at a surface that exists.
 *
 * Every AiSurfaceKind is covered (exhaustive switch); the remediationFor() return
 * is never null, so the UI can always render a fix beside a finding.
 */
import type { AiSurface, AiSurfaceKind, AiSurfaceRisk } from "./types";

/** A deterministic remediation for one discovered surface. */
export interface Remediation {
  /** The surface kind this guidance is for. */
  kind: AiSurfaceKind;
  /** Normalized provider slug (echoed from the surface). */
  provider: string;
  /** One-line summary of the gap being closed. */
  summary: string;
  /** Ordered, human-readable steps to route the surface through the gate. */
  steps: string[];
  /** A copy-pasteable code snippet that wires the call through the gate. */
  snippet: string;
  /** Relative urgency, derived from the surface risk (critical/high jump the
   *  queue). Deterministic: same risk -> same priority. */
  priority: "now" | "soon" | "later";
}

/** Map the surface risk onto a remediation priority. Pure + total. */
function priorityFor(risk: AiSurfaceRisk): Remediation["priority"] {
  switch (risk) {
    case "critical":
      return "now";
    case "high":
      return "soon";
    case "medium":
    case "low":
      return "later";
  }
}

/** The canonical gate call every remediation routes a surface through. Kept here
 *  (not duplicated per-kind) so the "route it through the gate" shape is one
 *  source of truth — mirrors POST /api/gate/authorize / authorize() in
 *  src/lib/ogiam/authorize.ts. */
function gateSnippet(action: string, provider: string): string {
  return [
    `import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";`,
    ``,
    `// Route the ${provider} call through the OGIAM gate BEFORE it executes.`,
    `const decision = await fetchWithRefresh("/api/gate/authorize", {`,
    `  method: "POST",`,
    `  headers: jsonHeaders(),`,
    `  body: JSON.stringify({ action: "${action}", provider: "${provider}", input }),`,
    `}).then((r) => r.json());`,
    `if (decision.outcome !== "allow") throw new Error(decision.reason);`,
    `// ...only now invoke the model. Every decision is recorded in the`,
    `// hash-chained ledger, so this surface is no longer ungoverned.`,
  ].join("\n");
}

/**
 * Deterministic remediation for one surface. Exhaustive over AiSurfaceKind: a new
 * kind added to the union forces a compile error here until its guidance exists,
 * so detection can never outrun remediation.
 */
export function remediationFor(surface: Pick<AiSurface, "kind" | "provider" | "risk">): Remediation {
  const { kind, provider, risk } = surface;
  const priority = priorityFor(risk);
  const base = { kind, provider, priority };

  switch (kind) {
    case "ai_sdk":
      return {
        ...base,
        summary: `Ungoverned ${provider} SDK call — wrap it in a gate-authorized client.`,
        steps: [
          `Locate the ${provider} SDK invocation flagged at this location.`,
          `Before the model call, ask the gate for a decision via POST /api/gate/authorize.`,
          `Pass the user/agent input so the gate can apply input + context policy.`,
          `Only invoke the model when the decision is "allow"; surface the reason otherwise.`,
        ],
        snippet: gateSnippet(`${provider}.completion`, provider),
      };
    case "provider_endpoint":
      return {
        ...base,
        summary: `Hardcoded ${provider} endpoint bypasses the gate — proxy it through OGIAM.`,
        steps: [
          `Replace the direct ${provider} hostname with a call to the gate-authorized path.`,
          `Move the provider base URL into an env var; never hardcode the model host.`,
          `Authorize the request at /api/gate/authorize so traffic is policy-checked + logged.`,
          `Have the gate forward to the provider only on an "allow" decision.`,
        ],
        snippet: gateSnippet(`${provider}.request`, provider),
      };
    case "api_key":
      return {
        ...base,
        summary: `Exposed ${provider} key = unmetered, ungoverned model access. Revoke + vault it now.`,
        steps: [
          `Revoke the leaked ${provider} key in the provider console immediately.`,
          `Remove the literal from source and purge it from git history.`,
          `Store the new key in a server-side secret store; never ship it to the client bundle.`,
          `Route every call that uses it through the gate so usage is metered + audited.`,
        ],
        snippet: gateSnippet(`${provider}.completion`, provider),
      };
    case "ai_route":
      return {
        ...base,
        summary: `AI-backed route runs ungoverned — gate it before the handler invokes the model.`,
        steps: [
          `Add a gate authorization as the first step of the route handler.`,
          `Pass the request payload so input governance + rate policy apply.`,
          `Return the gate's denial reason as a typed error; never fail open.`,
          `The recorded decision becomes this route's audit trail.`,
        ],
        snippet: gateSnippet(`${provider}.route`, provider),
      };
    case "mcp_server":
      return {
        ...base,
        summary: `Configured MCP server is an ungoverned tool surface — gate every tool call.`,
        steps: [
          `Pin the MCP server to a known version + integrity hash; reject unpinned servers.`,
          `Route each tool invocation through the gate so tool calls are policy-checked.`,
          `Scope the server's credentials to the minimum; never share the agency-wide token.`,
          `Record each tool decision in the ledger so the MCP surface is auditable.`,
        ],
        snippet: gateSnippet(`mcp.tool_call`, provider),
      };
  }
}

/** Remediation for every surface in a discovered set, in input order. Pure. */
export function remediateAll(
  surfaces: ReadonlyArray<Pick<AiSurface, "kind" | "provider" | "risk">>,
): Remediation[] {
  return surfaces.map(remediationFor);
}
