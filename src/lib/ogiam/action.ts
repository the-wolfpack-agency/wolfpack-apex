/**
 * Build a typed OgiamAction from a tool dispatch.
 *
 * The action schema is derived from the tool the assistant is about to run, so
 * it stays DRY with the tool registry (name, capability, requiresConfirmation).
 * Parameters are redacted with the shared ai-gateway redactor BEFORE anything is
 * hashed or stored, so raw PII or secrets never enter the OGIAM ledger. The
 * redactor's hits double as the PII and secret signals the PDP consumes.
 */

import { createHash } from "crypto";
import { redactText, type RedactionKind } from "@/lib/ai/redaction";
import type { OgiamAction, OgiamSignals } from "./types";

const SECRET_KINDS: ReadonlySet<RedactionKind> = new Set(["api_key"]);
const PII_KINDS: ReadonlySet<RedactionKind> = new Set([
  "email",
  "phone",
  "ssn",
  "credit_card",
  "iban",
  "ip",
]);

/** Stable JSON with sorted keys, so the same parameters always hash the same. */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface BuildActionInput {
  tool: string;
  capability: string;
  isMutation: boolean;
  surface: string;
  workflowId?: string;
  /** The validated tool parameters. Redacted here before any hashing. */
  params: unknown;
  /** An externally supplied injection score (advisory), if a PIP computed one. */
  injectionScore?: number;
}

/**
 * Construct the OgiamAction. Pure aside from the redactor (which is itself pure).
 * Returns both the action and the redacted parameter view so the ledger can
 * store a safe, human-readable snapshot alongside the hash.
 */
export function buildAction(input: BuildActionInput): {
  action: OgiamAction;
  redactedParams: string;
} {
  const raw = canonicalJSON(input.params ?? {});
  const { text: redactedParams, hits } = redactText(raw);

  const signals: OgiamSignals = {
    piiDetected: hits.some((h) => PII_KINDS.has(h.kind)),
    secretDetected: hits.some((h) => SECRET_KINDS.has(h.kind)),
    ...(typeof input.injectionScore === "number"
      ? { injectionScore: input.injectionScore }
      : {}),
  };

  // Hash the REDACTED parameters: the ledger proves which (sanitized) inputs the
  // decision was made over, without ever storing the raw sensitive values.
  const paramsHash = createHash("sha256").update(redactedParams).digest("hex");

  return {
    action: {
      tool: input.tool,
      capability: input.capability,
      isMutation: input.isMutation,
      surface: input.surface,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      paramsHash,
      signals,
    },
    redactedParams,
  };
}
