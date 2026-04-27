/**
 * support / categorizer — AI auto-classifier for support tickets.
 *
 * Classifies an incoming ticket title + body + (optional) diagnostic text
 * into one of a fixed set of operator-facing categories. Used by the
 * POST /api/support/tickets manual-create flow AND the email inbox
 * poller so every ticket lands with the right category whether it was
 * filed by an operator or by a customer email.
 *
 * Implementation:
 *   - Uses the provider-neutral AI abstraction (`getAIClient().complete`)
 *     so the cheap-tier router decision (Haiku today) stays a routing
 *     concern, not a feature concern. Cost per call is ~fractions of a
 *     cent.
 *   - Asks the model for a JSON object: { category, confidence,
 *     reasoning }. We parse defensively. Anything that fails parse,
 *     missing-category, low-confidence (<0.6), unknown-category, or AI
 *     throw → falls back to category 'general' with confidence 0. The
 *     caller never has to handle a thrown error from this helper.
 *   - sensitivity='public' (ticket bodies are operator data, not PHI),
 *     metadata.feature='support.categorize' so analytics can split this
 *     specific call out of the broader ai.completion firehose.
 */

import { getAIClient } from "@/lib/ai";
import type { AIMessage } from "@/lib/ai";

export type SupportCategory =
  | "m365"
  | "azure"
  | "instinct"
  | "wolfpack-auto"
  | "porsche-classes"
  | "billing"
  | "urgent"
  | "general";

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  "m365",
  "azure",
  "instinct",
  "wolfpack-auto",
  "porsche-classes",
  "billing",
  "urgent",
  "general",
] as const;

export interface CategorizeInput {
  title: string;
  body: string;
  diagnostic_text?: string;
}

export interface CategorizeResult {
  category: SupportCategory;
  confidence: number;
  reasoning?: string;
}

/**
 * Confidence floor below which we coerce the result to 'general'. Set
 * intentionally a touch higher than the Anthropic model's "I'm guessing"
 * range so the operator sees a real signal when the AI was sure.
 */
const CONFIDENCE_FLOOR = 0.6;

/* eslint-disable max-len */
const SYSTEM_PROMPT = `You are a support-ticket classifier for the Wolfpack Agency operator team. Your job is to read one ticket and pick exactly one category from this list:

- "m365": Microsoft 365 issues (email, Outlook, calendar, Teams, OneDrive, SharePoint, Entra ID / Azure AD sign-in errors like AADSTSxxxxx, MFA, license assignment).
- "azure": Azure cloud issues that are NOT m365 sign-in (App Service, Functions, Storage, networking, Resource Manager, billing on Azure subscriptions).
- "instinct": Issues with the Wolfpack Instinct platform itself (the operator-facing app, dashboards, automations, sites, HR features, support feature, login to Instinct).
- "wolfpack-auto": Issues with the Wolfpack Auto dealer platform (inventory, leads, dealer onboarding, AgenticQA pipeline running on Auto).
- "porsche-classes": Questions about the Porsche academy class scheduling or registrations.
- "billing": License costs, invoices, payment methods, subscription changes, refunds.
- "urgent": ANY indication of an active security incident, suspected breach, account takeover, ransomware, data loss, or a user fully locked out of their account RIGHT NOW. This category overrides the others when those signals are present.
- "general": anything that does not clearly fit one of the above.

Rules:
1. Return ONLY a JSON object with the keys category, confidence, reasoning. No prose, no markdown fences.
2. confidence is a number from 0.0 to 1.0 representing how sure you are.
3. reasoning is one short sentence (under 140 chars) explaining the choice.
4. If the ticket mentions an active breach, lockout that is happening now, ransomware, data loss, or imminent security risk, choose "urgent" even if it would also fit another bucket.
5. If you are not sure, return "general" with confidence below 0.6 — do not guess wildly.

Output exactly: {"category":"...","confidence":0.0,"reasoning":"..."}`;
/* eslint-enable max-len */

/**
 * Build the user message payload from a ticket. Title and body are
 * concatenated with a small label so the model can distinguish subject
 * from body. Diagnostic text is appended only when present so we don't
 * waste tokens on an empty section.
 */
function buildUserMessage(input: CategorizeInput): string {
  const lines: string[] = [];
  lines.push(`Subject: ${input.title}`);
  lines.push(`Body:\n${input.body}`);
  if (input.diagnostic_text && input.diagnostic_text.trim().length > 0) {
    lines.push(`Diagnostic:\n${input.diagnostic_text}`);
  }
  lines.push(
    "\nReturn the JSON object now. Do not include any other text.",
  );
  return lines.join("\n\n");
}

/**
 * Defensive JSON parser. The model occasionally wraps its output in a
 * markdown fence or prepends a sentence. We strip the most common
 * envelope variations before JSON.parse so a single stray newline does
 * not cost us a categorization.
 */
function tryParseJSON(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  /* Strip a leading/trailing ``` fence (``` or ```json). */
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  /* Pull out the first {...} block — handles "Here is the JSON: { ... }". */
  const braceStart = fenced.indexOf("{");
  const braceEnd = fenced.lastIndexOf("}");
  const candidate =
    braceStart >= 0 && braceEnd > braceStart
      ? fenced.slice(braceStart, braceEnd + 1)
      : fenced;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function isSupportCategory(v: unknown): v is SupportCategory {
  return (
    typeof v === "string" &&
    (SUPPORT_CATEGORIES as readonly string[]).includes(v)
  );
}

function clampConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

const FALLBACK: CategorizeResult = {
  category: "general",
  confidence: 0,
  reasoning: "categorizer fallback",
};

/**
 * Auto-classify a support ticket. Never throws — every error path
 * returns the 'general' fallback so call sites do not have to wrap this
 * in try/catch a second time. Callers are still encouraged to use a
 * try/catch for belt-and-braces safety because the wider transaction
 * around them (createTicket → setTicketCategory) shouldn't fail when
 * the AI provider is degraded.
 */
export async function categorizeTicket(
  input: CategorizeInput,
): Promise<CategorizeResult> {
  const userMessage = buildUserMessage(input);
  const messages: AIMessage[] = [{ role: "user", content: userMessage }];

  let response;
  try {
    response = await getAIClient().complete({
      messages,
      system: SYSTEM_PROMPT,
      max_tokens: 200,
      /* Low temperature: classification, not creative writing. We
         want stable + reproducible outputs. */
      temperature: 0,
      model_tier: "cheap",
      sensitivity: "public",
      metadata: { feature: "support.categorize" },
    });
  } catch (err) {
    console.warn(
      "[support/categorizer] AI complete threw:",
      (err as Error).message,
    );
    return { ...FALLBACK };
  }

  const parsed = tryParseJSON(response.content);
  if (!parsed || typeof parsed !== "object") {
    return { ...FALLBACK, reasoning: "categorizer parse failure" };
  }
  const obj = parsed as Record<string, unknown>;
  const cat = isSupportCategory(obj.category) ? obj.category : null;
  const confidence = clampConfidence(obj.confidence);
  const reasoning =
    typeof obj.reasoning === "string" && obj.reasoning.length > 0
      ? obj.reasoning.slice(0, 280)
      : undefined;

  if (!cat) {
    return { ...FALLBACK, reasoning: "unknown category from model" };
  }
  /* Low-confidence guard: even when the model picked a specific
     category, treat it as 'general' so we never mislabel a ticket on a
     wobbly signal. The reasoning is preserved so the operator + the
     learning loop can see what the model was leaning toward. */
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      category: "general",
      confidence,
      reasoning:
        reasoning ??
        `low confidence (${confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
    };
  }

  return { category: cat, confidence, reasoning };
}
