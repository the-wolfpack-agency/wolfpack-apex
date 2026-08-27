/**
 * One gate every answer passes through, whatever produced it.
 *
 * WHY THIS EXISTS. The model router is a real chokepoint and holds real
 * controls: outbound redaction, a response-safety inspector, a content policy
 * gate, residency, retention, the constitution, a signed decision ledger.
 *
 * It is also not in the path for most answers. Measured over ninety days,
 * 6,381 tool invocations against 577 model completions: about 92% of what this
 * assistant says never enters the router at all. The deterministic path, which
 * is the thing the product is sold on, had no governance on it whatsoever. It
 * read documents out of the Brain and printed them.
 *
 * That is not a misconfiguration. Every control is correctly built and
 * correctly wired TO THE ROUTER. The design assumed the model was the risky
 * surface, and in a product whose whole argument is not using the model, the
 * controls ended up standing where the traffic is not.
 *
 * The consequence was visible before the cause: personal data from a
 * spreadsheet quoted verbatim into a chat window, and ai.response_redacted
 * reading zero for the life of the feature. I reported that zero as good news.
 * It meant the redactor was in the wrong place.
 *
 * SO THE CHOKEPOINT MOVES to the answer boundary. Not the model boundary.
 * Every answer, from any source, passes here before it reaches a person.
 *
 * WHAT IT DOES NOT DO. It does not re-run the router's model-specific gates:
 * residency and retention are properties of sending data to a provider, and a
 * zero-token answer sends nothing anywhere. Applying them here would report
 * controls that did not happen, which is the failure this codebase has spent a
 * month removing.
 */

import { trackEvent } from "@/lib/analytics";
import { NEVER_QUOTE_KINDS, redactText, type RedactionKind } from "@/lib/ai/redaction";

export interface GatedAnswer {
  text: string;
  /** Kinds removed, for the caller to surface. Empty when nothing was. */
  removed: RedactionKind[];
}

/**
 * Answers that have already been through the router.
 *
 * Redacting twice is not harmful, but it would double-count in the analytics
 * and make the router's own numbers unreadable. The source tells us.
 */
const ROUTER_COVERED = new Set(["ai"]);

/**
 * Put an answer through the gate.
 *
 * PURE. No I/O beyond the analytics event, so it cannot fail an answer that
 * was otherwise fine. A gate that can turn a good answer into an error is a
 * gate somebody removes.
 */
export function gateAnswer(args: {
  text: string;
  source: string;
  userId: string;
  userRole: string;
  workflowId?: string;
}): GatedAnswer {
  const { text, source, userId, userRole, workflowId } = args;
  if (!text) return { text, removed: [] };

  /* The model path already redacted on the way out of the router. Passing it
     again would count the same removal twice in two different places. */
  if (ROUTER_COVERED.has(source)) return { text, removed: [] };

  const result = redactText(text, NEVER_QUOTE_KINDS);
  if (!result.redacted || result.hits.length === 0) return { text, removed: [] };

  const removed = [...new Set(result.hits.map((h) => h.kind))].sort();

  /* THE EVENT THAT WOULD HAVE CAUGHT THIS. ai.response_redacted only ever
     covered the model path, so it read zero while personal data went out on
     the deterministic one. This one names the source, so a zero here is
     answerable: it means the path was covered and clean, not that nobody was
     looking at it. */
  trackEvent("assistant.answer_redacted", userId, userRole, {
    source,
    removed: removed.join(","),
    hit_count: result.hits.length,
    ...(workflowId ? { workflow_id: workflowId } : {}),
  });

  return { text: result.text, removed };
}
