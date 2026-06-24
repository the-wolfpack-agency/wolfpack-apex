/**
 * Operation tool factory.
 *
 * Turns every declarative AgentOperation (registry.ts) into an agent-only
 * assistant tool with NO per-function handler code. One factory, run once at
 * module load, registers `op_${id}` for each operation. The tool:
 *   - matches the operation's `intent` and, on a hit, extracts each field's
 *     value from the instruction (buildValues);
 *   - is `agentOnly`, so the dispatcher never fires it for a human (a human uses
 *     the real product UI for the same action);
 *   - carries the operation's `capability`, so the shared role gate + the OGIAM
 *     enforce gate govern it exactly like any other agent tool;
 *   - on success returns an `operation` descriptor (id, method, path, values,
 *     required) that the agent executor invokes ON THE OWNER'S BEHALF through a
 *     fresh short-lived on-behalf token. The handler itself performs NO side
 *     effect and mints no token: it only declares what should be done, so it is
 *     pure, deterministic, and never throws.
 *
 * This is the whole point of the registry: a NEW invocable operation is a few
 * declarative lines in registry.ts, and this factory makes it a real,
 * governed, agent-invocable tool automatically.
 */

import { z } from "zod";
import { registerTool } from "@/lib/assistant/tools/registry";
import type { ToolContext, ToolResult } from "@/lib/assistant/tools/types";
import { AGENT_OPERATIONS, type AgentOperation } from "./registry";

/**
 * Run every field extractor against the instruction and collect the non-empty
 * values into a map. A field that extracts nothing is simply omitted (the
 * executor's required-field check then escalates to the owner). Returns {} when
 * the operation has no fields. Pure + never throws.
 */
export function buildValues(
  message: string,
  op: AgentOperation,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of op.fields) {
    let v: string | undefined;
    try {
      v = field.extract(message);
    } catch {
      /* A misbehaving extractor must not break intent matching; treat as absent.
         A required field left absent makes the executor escalate, never submit
         an invalid action. */
      v = undefined;
    }
    if (typeof v === "string" && v.trim().length > 0) {
      values[field.name] = v;
    }
  }
  return values;
}

/** Register one operation as an agent-only tool. Exported for direct testing. */
export function registerOperationTool(op: AgentOperation): void {
  registerTool<Record<string, unknown>, { operation_id: string }>({
    name: `op_${op.id}`,
    description: op.summary,
    capability: op.capability,
    // Never a confirmation gate: an agent run cannot answer a confirmation
    // prompt. Governance comes from the OGIAM enforce gate + the owner-bounded
    // on-behalf token, and a high-risk operation is escalated by the executor.
    requiresConfirmation: false,
    // Agent-only: the dispatcher skips this for a human, who uses the real UI.
    agentOnly: true,
    // Passthrough schema: the values are already extracted + validated by the
    // operation's own field extractors; we do not re-shape them here.
    paramSchema: z.object({}).passthrough(),
    matchIntent: (message: string) =>
      op.intent.test(message) ? buildValues(message, op) : null,
    handler: async (
      params: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult<{ operation_id: string }>> => ({
      ok: true,
      data: { operation_id: op.id },
      answer: `Executing: ${op.summary}.`,
      sources: [],
      operation: {
        id: op.id,
        method: op.method,
        path: op.path,
        values: params as Record<string, unknown>,
        required: op.fields.filter((f) => f.required).map((f) => f.name),
        // Carry the result-chaining target (if any) so the executor can fold
        // prior-step output into this body field before the required-field gate.
        fillFromPriorResults: op.fillFromPriorResults,
      },
    }),
  });
}

/**
 * Register every declarative operation as an agent-only tool. Idempotent: the
 * registry replaces a tool with the same name, so re-running (e.g. in tests) is
 * safe.
 */
export function registerOperationTools(): void {
  for (const op of AGENT_OPERATIONS) registerOperationTool(op);
}

// Register at module load so importing this file (from the tools barrel) wires
// every operation into the dispatcher's registry.
registerOperationTools();
