/**
 * AI Surface Inventory — types.
 *
 * "You cannot govern what you cannot see." Before OGIAM can gate, scan, or
 * red-team a client's AI, it has to DISCOVER every place AI touches their system:
 * every LLM SDK call, hardcoded provider endpoint, and AI key in their code. Each
 * discovered touchpoint is an AiSurface. The inventory is the foundation the
 * other AI-governance surfaces (input/context governance, memory integrity,
 * code-gov, MCP, continuous eval) register into — each becomes a new `kind` and
 * its own discovery source feeding this same inventory.
 *
 * Deliberately decoupled from platform-scan's ScanFinding/ScanCategory: an
 * inventory item is an ASSET (a thing that exists), not a defect, and overloading
 * the shared finding union would force every category switch in the scanner to
 * grow. This module reuses the detector PRIMITIVES (source walking, precision
 * provider signatures) without entangling the finding model.
 */

/** The class of AI touchpoint discovered. New AI-governance surfaces extend this
 *  union with their own discoverable kind (e.g. "mcp_server", "rag_retrieval"). */
export type AiSurfaceKind =
  | "ai_sdk" // an import/require of a known LLM SDK
  | "provider_endpoint" // a hardcoded model-provider API URL
  | "api_key" // a provider API key signature (precision-first)
  | "ai_route" // an app route/handler that is an AI feature
  | "mcp_server"; // a configured Model Context Protocol server (tool surface)

export type AiSurfaceRisk = "low" | "medium" | "high" | "critical";

/** One discovered AI touchpoint. `governed` is false until proven to route
 *  through a governance layer (the "ungoverned AI" gap is the sellable signal). */
export interface AiSurface {
  kind: AiSurfaceKind;
  /** Normalized provider slug: openai | anthropic | google | azure-openai |
   *  cohere | mistral | groq | replicate | huggingface | ollama | langchain |
   *  llamaindex | vertex | unknown. */
  provider: string;
  /** file:line (static) or a route path. */
  location: string;
  governed: boolean;
  risk: AiSurfaceRisk;
  /** Raw signal so a reviewer can verify without re-running. Never the secret
   *  itself — only a masked hint for api_key. */
  evidence: Record<string, string | number | boolean | null>;
}

/** A rollup over an inventory, for the dashboard header + the learning metric. */
export interface AiSurfaceSummary {
  total: number;
  ungoverned: number;
  byKind: Record<string, number>;
  byProvider: Record<string, number>;
  byRisk: Record<string, number>;
}
