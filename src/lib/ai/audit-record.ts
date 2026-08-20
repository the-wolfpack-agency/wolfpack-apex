/**
 * The record of what the router did to one AI call, as evidence.
 *
 * WHY THIS IS THE PART NOBODY ELSE HAS
 *
 * OpenRouter can tell you it blocked something; its own docs list detailed
 * audit logs among the things Guardrails does not cover. Router.com's launch
 * does not mention governance at all. Both can say "we filter". Neither can
 * hand a compliance officer something that officer can check.
 *
 * The difference matters because "we filter" is a claim about a vendor and an
 * audit record is a claim about YOUR data that survives the vendor. When a
 * regulated client asks what left their tenancy and what came back, a
 * screenshot of a dashboard is not an answer.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN LOGGING
 *
 *   APPEND ONLY, enforced in the database, so a row cannot be edited later.
 *   HASH CHAINED, so removing or altering any row breaks every hash after it
 *     and verifyChain() says exactly where.
 *   REPRODUCIBLE, because the hash is over canonical JSON with sorted keys, so
 *     an auditor recomputing it on their own machine gets the same answer.
 *
 * All three already existed in lib/audit-log.ts, built for HR and auth events.
 * This does not reimplement any of it; the AI gateway becomes another writer.
 * A second chain would have been a second thing to prove correct.
 *
 * WHAT IS NEVER IN A ROW
 *
 * Not the prompt, not the answer, not a redacted value. An audit record that
 * carries the content it is auditing becomes the largest copy of that content
 * in the estate, sitting in a table designed never to be deleted. So a row
 * carries WHAT HAPPENED and WHAT KIND: which model answered, what it cost, how
 * many credentials were withheld and of which kinds, whether a fetched
 * document tried to give instructions, whether the budget governed the call.
 * Somebody proving "no card number has ever left this tenancy" needs the
 * count and the kind, not the number.
 */
import type { AIModelTier } from "./types";

/** One AI call, as it will be recorded. Counts and kinds only, never content. */
export interface RouterAuditFacts {
  workspaceId: string;
  userId: string;
  feature: string;
  /** The model that answered, by registry id where known. */
  model: string;
  provider: string;
  /** What the caller asked for, and what the governor allowed. Equal on an
   *  ordinary call; different rows are the ones worth explaining. */
  requestedTier: AIModelTier;
  servedTier: AIModelTier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Values replaced on the way OUT, before the prompt left this process. */
  withheldOutbound: number;
  /** Values replaced on the way BACK, before the answer was shown or stored. */
  withheldInbound: number;
  /** Kinds seen in either direction, sorted, never values. */
  withheldKinds: string[];
  /** Fetched documents that tried to instruct the model. */
  injectionAttempts: number;
  /** Present when the budget governor changed or refused the call. */
  budgetState?: "approaching" | "over" | "stopped";
}

export const ROUTER_AUDIT_ACTION = "ai.call.completed";

/**
 * Shape the facts into an audit entry.
 *
 * Pure, so what gets written is testable without a database, and so the
 * "never content" rule can be asserted on the OUTPUT rather than promised in
 * a comment.
 */
export function buildRouterAuditEntry(facts: RouterAuditFacts): {
  actor: { user_id: string; role: string };
  action: string;
  resourceType: string;
  resourceId: string;
  afterState: Record<string, unknown>;
} {
  return {
    actor: { user_id: facts.userId, role: "system" },
    action: ROUTER_AUDIT_ACTION,
    resourceType: "ai_call",
    /* The workspace, not a per-call id: an auditor asks "what happened in this
       tenancy", and a random id per row answers a question nobody has. */
    resourceId: facts.workspaceId,
    afterState: {
      feature: facts.feature,
      model: facts.model,
      provider: facts.provider,
      requested_tier: facts.requestedTier,
      served_tier: facts.servedTier,
      input_tokens: facts.inputTokens,
      output_tokens: facts.outputTokens,
      cost_usd: facts.costUsd,
      withheld_outbound: facts.withheldOutbound,
      withheld_inbound: facts.withheldInbound,
      withheld_kinds: [...facts.withheldKinds].sort(),
      injection_attempts: facts.injectionAttempts,
      ...(facts.budgetState ? { budget_state: facts.budgetState } : {}),
      /* Stated in the row itself, because the person reading an export a year
         from now will not have read this file. */
      contains_content: false,
    },
  };
}
