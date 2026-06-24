/**
 * Agent action-summary ingestion into the Central Brain.
 *
 * The OGIAM ledger + ogiam_action_outcomes are the authoritative, tamper-evident
 * record of what a governed agent did. This module additionally feeds a CONCISE,
 * human-readable summary of each governed action into the Brain so the assistant
 * can retrieve "what has this agent been doing" semantically alongside the rest
 * of the knowledge base. It is a derived, lossy view; the ledger remains the
 * source of truth.
 *
 * Best effort + graceful by contract:
 *   - The summary text is already the redacted + truncated result snippet the
 *     dispatcher captured; this module adds no raw payload.
 *   - ingest() may skip embedding when the embedder is unconfigured (the brain
 *     layer handles that). The brain upload-filter is relied on downstream to
 *     drop low-signal content; this module does not duplicate that gate.
 *   - Any failure is swallowed. A Brain write must NEVER break dispatch or the
 *     gate. The caller already wraps this, but it is also defensive here.
 */

import { ingest } from "@/lib/brain/ingest";

/** Tag stamped on every agent audit summary so it is filterable in the Brain. */
export const AGENT_AUDIT_BRAIN_TAG = "agent-audit";

export interface IngestAgentActionInput {
  workspaceId: string;
  agentId: string;
  /** The tool the agent ran. */
  tool: string;
  /** Concise outcome word ("ok" or the failure code). */
  outcome: string;
  /** The OGIAM rule id that fired for this action. */
  ruleId: string;
  /** The already redacted + truncated result snippet. */
  resultRedacted: string;
}

/**
 * Build a SHORT summary of a governed agent action and ingest it into the Brain
 * as an agent-audit record. Best effort: never throws.
 */
export async function ingestAgentAction(
  input: IngestAgentActionInput,
): Promise<void> {
  try {
    const snippet = (input.resultRedacted ?? "").trim();
    const summary =
      `Agent ${input.agentId} ran ${input.tool}: ${input.outcome} ` +
      `(rule ${input.ruleId}).` +
      (snippet ? ` ${snippet}` : "");

    await ingest({
      filename: `agent-audit-${input.agentId}-${input.tool}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from(summary, "utf8"),
      uploadedBy: input.agentId,
      uploaderRole: "agent",
      tags: [AGENT_AUDIT_BRAIN_TAG, `agent:${input.agentId}`, `tool:${input.tool}`],
    });
  } catch (err) {
    // Graceful degradation: a Brain failure must never propagate into dispatch.
    console.warn(
      "[agent-audit] brain ingest failed:",
      (err as Error)?.message ?? "unknown",
    );
  }
}
