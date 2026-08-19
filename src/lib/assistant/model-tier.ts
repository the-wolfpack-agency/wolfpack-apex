/**
 * Choosing how much model a single assistant turn actually needs.
 *
 * WHY THIS EXISTS
 *
 * `callAI` sent `model_tier: "standard"` for every message. A one-word
 * greeting, a "what are my meetings" lookup and a multi-step reasoning question
 * with three screenshots attached all declared the same capability floor. The
 * routing infrastructure was in place and welded shut: the selection router
 * would faithfully pick the same tier every time, so the catalogue of models in
 * `lib/ai/models/registry.ts` had exactly one reachable band.
 *
 * The tier is a statement about what the TASK needs, not about cost directly.
 * Cost follows from it, which is why this returns a reason as well: an operator
 * looking at /admin/ai-router should be able to see a downgrade and tell a
 * deliberate one from a bug.
 *
 * DETERMINISTIC ON PURPOSE
 *
 * No model call decides which model to call. That would add latency and cost to
 * every turn to save cost on some of them, and it would make routing
 * unreproducible — the same question could route differently twice, which is
 * impossible to debug and impossible to bill against. Every rule here is a
 * pure function of the turn, so a given input always routes the same way and
 * every rule is directly testable.
 *
 * SAFETY POSTURE
 *
 * Ambiguity resolves UPWARD. A turn we cannot confidently call trivial gets
 * `standard`, the tier everything used before this file existed, so the failure
 * mode of a wrong guess is "no saving" rather than "a worse answer". Nothing
 * here can route a hard question to a small model on a hunch.
 */
import type { AIModelTier } from "@/lib/ai/types";

export interface TierChoice {
  tier: AIModelTier;
  /** Why, in a token an operator can group by on /admin/ai-router. */
  reason: string;
}

/** Ceiling for the short-statement downgrade. Deliberately well below
 *  LONG_MESSAGE_CHARS: this rule guesses, so it gets the least room. */
const SHORT_STATEMENT_CHARS = 40;

/** Verb-initial phrasing means work is being asked for, however briefly. */
const IMPERATIVE_RE =
  /^\s*(pull|show|list|get|find|fetch|send|create|add|update|delete|remove|check|run|open|build|make|generate|export|import|assign|schedule|book|draft|write|compare|review)\b/i;

/** Above this many characters a turn is carrying real context. */
const LONG_MESSAGE_CHARS = 600;

/** Attachment text long enough that reading it IS the task. */
const HEAVY_ATTACHMENT_CHARS = 1500;

/**
 * Turns that are complete in themselves: greetings, thanks, acknowledgements.
 * Matched whole, so "thanks for explaining how the invite flow works" does NOT
 * match — only a turn that is nothing but the pleasantry.
 */
const TRIVIAL_RE =
  /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|got it|cool|nice|great|perfect|sounds good|understood|nevermind|never mind|sure|yes|no|yep|nope|bye|goodbye)[\s!.?]*$/i;

/**
 * Wording that signals multi-step reasoning rather than recall. These ask the
 * model to derive something, and a small model answering them confidently is
 * worse than a large one answering them slowly.
 */
const REASONING_RE =
  /\b(why|analy[sz]e|analysis|compare|comparison|trade[- ]?offs?|root cause|diagnose|debug|explain how|walk me through|step by step|strategy|recommend|should we|pros and cons|implications|forecast|project(?:ion)?|reconcile|discrepan|inconsisten)\b/i;

/** Structured output asks: the model must hold a shape while it writes. */
const COMPOSITION_RE =
  /\b(draft|write|compose|summari[sz]e|rewrite|outline|plan|proposal|email to|report on)\b/i;

export interface TierInput {
  message: string;
  /** Rendered attachment block for this turn, if any. */
  attachmentBlock?: string;
  /** Prior turns in this conversation. A long thread carries context the model
   *  has to keep straight, which is itself a reason not to shrink. */
  historyLength?: number;
}

/**
 * Pick the capability floor for one turn.
 *
 * Order matters: the upgrade rules are checked BEFORE the downgrade rule, so a
 * short message that asks a hard question ("why did revenue drop?") is not
 * mistaken for a trivial one on length alone.
 */
/**
 * An explicit instruction to use a particular tier.
 *
 * WHY AN OVERRIDE EXISTS AT ALL
 *
 * Every rule below infers what a turn needs, which is right for normal use and
 * useless for two jobs: proving the router actually reaches each model, and
 * saying "I do not care how good this is, use the cheapest thing" and meaning
 * it. Inference cannot express either, because the whole point is to overrule
 * the inference.
 *
 * The directive is REMOVED from the message before the model sees it. Leaving
 * "/cheap" in the prompt makes the model answer about the word.
 *
 * UPWARD ONLY BY ACCIDENT, NEVER SILENTLY. An override is honoured exactly as
 * asked, including down. That is deliberate: a person who types "use the
 * cheapest model" and gets a premium answer has been ignored, and an override
 * nobody can trust is worse than none.
 */
export interface TierDirective {
  tier: AIModelTier;
  /** The message with the directive taken out. */
  cleaned: string;
}

const DIRECTIVES: { re: RegExp; tier: AIModelTier }[] = [
  /* Slash form first: unambiguous, and what somebody testing will reach for. */
  { re: /(^|\s)\/(cheap|cheapest|small)\b/i, tier: "cheap" },
  { re: /(^|\s)\/(standard|normal|mid)\b/i, tier: "standard" },
  { re: /(^|\s)\/(premium|best|large|reasoning)\b/i, tier: "premium" },
  /* Plain English, because not everybody knows the slash form exists. */
  { re: /\buse (?:the )?(?:cheapest|smallest|lowest[- ]cost)(?: model)?\b/i, tier: "cheap" },
  { re: /\buse (?:the )?(?:standard|normal|default)(?: model)?\b/i, tier: "standard" },
  { re: /\buse (?:the )?(?:best|premium|largest|strongest)(?: model)?\b/i, tier: "premium" },
];

export function parseTierDirective(message: string): TierDirective | null {
  for (const { re, tier } of DIRECTIVES) {
    if (re.test(message)) {
      return { tier, cleaned: message.replace(re, " ").replace(/\s{2,}/g, " ").trim() };
    }
  }
  return null;
}

export function selectAssistantTier(input: TierInput): TierChoice {
  const message = (input.message ?? "").trim();
  const attachmentChars = input.attachmentBlock?.length ?? 0;
  const history = input.historyLength ?? 0;

  /* An explicit instruction beats every inference below, in both directions.
     Checked first so nothing else can quietly overrule what was asked for. */
  const directive = parseTierDirective(message);
  if (directive) return { tier: directive.tier, reason: "user_override" };

  /* --- Upgrades. Anything that genuinely needs more capability. --- */

  if (attachmentChars >= HEAVY_ATTACHMENT_CHARS) {
    /* Reading a dense document or several screenshots and answering about them
       is the case where a small model visibly degrades: it starts summarising
       instead of answering, or drops half the attachment. */
    return { tier: "premium", reason: "heavy_attachment" };
  }

  if (REASONING_RE.test(message)) {
    return { tier: "premium", reason: "reasoning_request" };
  }

  if (attachmentChars > 0) {
    /* Any attachment at all means the answer must be grounded in specific
       content rather than recalled. Standard, not premium: a short screenshot
       is not a research task. */
    return { tier: "standard", reason: "has_attachment" };
  }

  if (message.length >= LONG_MESSAGE_CHARS) {
    return { tier: "standard", reason: "long_message" };
  }

  if (COMPOSITION_RE.test(message)) {
    return { tier: "standard", reason: "composition_request" };
  }

  if (history >= 6) {
    /* Deep in a thread the model is tracking prior turns. Shrinking here is
       where "it forgot what we were talking about" comes from. */
    return { tier: "standard", reason: "long_conversation" };
  }

  /* --- The only downgrade. --- */

  if (TRIVIAL_RE.test(message)) {
    return { tier: "cheap", reason: "trivial_turn" };
  }

  if (
    message.length > 0 &&
    message.length <= SHORT_STATEMENT_CHARS &&
    !message.includes("?") &&
    !IMPERATIVE_RE.test(message)
  ) {
    /* A short statement with no question and no instruction verb: an
       acknowledgement, a name, a pasted id.
       
       This was the one rule that could genuinely hurt, and it did. At 80
       characters and with no verb check, "Pull the delivery records for the
       three Centers in the northeast region" routed to the smallest model —
       a real instruction, silently downgraded, which is exactly the failure
       this file claims not to allow. Caught by its own test before shipping.
       Now: half the length, and anything phrased as a command is excluded. */
    return { tier: "cheap", reason: "short_statement" };
  }

  /* Everything else keeps exactly the behaviour that shipped before this
     existed. An unrecognised turn is never a reason to spend less. */
  return { tier: "standard", reason: "default" };
}
