/**
 * src/lib/ai/policy — what redaction cannot see.
 *
 * WHY THIS EXISTS SEPARATELY FROM redaction.ts
 *
 * Redaction finds SHAPES. A card number is sixteen digits that pass Luhn, an
 * email has an @, an API key looks like an API key. That is why redaction can
 * be exhaustive and certain, and it is also its ceiling: it cannot see a
 * sentence that is dangerous because of what it MEANS.
 *
 * None of the following contains a single redactable token, and every one of
 * them is a problem leaving a customer's chatbot:
 *
 *   "You'll qualify for 2.9% APR on that."          a rate we do not set
 *   "We'll beat any price in the state."            a promise nobody authorized
 *   "That's covered under your warranty."           a coverage decision
 *   "There are no open recalls, it's safe to drive."  a safety assurance
 *   "Yes, that's in stock, I'll hold one for you."   an inventory commitment
 *
 * So this is a second gate, deliberately not merged with the first. Redaction
 * protects the customer's data; this protects the customer from the model.
 *
 * DETERMINISTIC FIRST, AND MOSTLY DETERMINISTIC ONLY
 *
 * Every rule here is a regular expression a client can read, argue with, and
 * edit. No model call, no probability, no drift between two runs on the same
 * text. That matters more than coverage: a safety layer nobody can explain is
 * one nobody will accept liability for, and "the classifier thought so" is not
 * an answer to a brand's legal team. A classifier belongs downstream of this,
 * on the narrow set of cases the rules mark ambiguous, and it is not in this
 * file.
 *
 * FOUR OUTCOMES, NOT TWO
 *
 * allow    nothing matched.
 * redact   the span is removed, the rest of the answer stands. For a claim
 *          that is wrong in itself but does not poison the paragraph.
 * block    the answer is withheld and replaced by a reason. For a promise the
 *          business cannot be held to.
 * escalate the answer is withheld and a human is asked. For a question that
 *          has a correct answer which we are not the right party to give.
 *
 * Blocking silently is how a safety layer becomes a support ticket, so every
 * outcome carries the rule that caused it and a sentence for the reader.
 *
 * ReDoS safety, matching redaction.ts: every pattern is linear, compiled once
 * at module scope, and input is bounded before any pattern runs.
 */

/** The most text any single pass will scan. Mirrors redaction's bound. */
export const MAX_POLICY_INPUT_LEN = 100_000;

export type PolicyAction = "allow" | "redact" | "block" | "escalate";

/** Which direction a rule guards. Most guard what comes BACK from the model. */
export type PolicyDirection = "prompt" | "response" | "both";

/**
 * Which business this tenant is.
 *
 * Not decoration. "In stock" is an ordinary sentence for a car brand, whose
 * inventory question ends in a conversation with a dealer, and a commitment for
 * a retailer, whose customer will click buy on the strength of it. A single
 * merged rule set would either miss the retailer's exposure or nag the car
 * brand about a sentence that was fine.
 */
export type PolicyProfile = "automotive" | "retail" | "baseline";

export interface PolicyRule {
  id: string;
  /** What a client reads in the panel. Plain, not a rule name. */
  title: string;
  /** Why this exists, in the client's terms. Shown beside a refusal. */
  why: string;
  action: Exclude<PolicyAction, "allow">;
  direction: PolicyDirection;
  pattern: RegExp;
}

export interface PolicyFinding {
  ruleId: string;
  title: string;
  why: string;
  action: Exclude<PolicyAction, "allow">;
  /** The matched text, TRUNCATED. Enough to see what tripped, never the whole
   *  answer, because findings are stored and shown. */
  excerpt: string;
}

export interface PolicyVerdict {
  action: PolicyAction;
  findings: PolicyFinding[];
  /** The text to use. Unchanged when allowed, spans removed when redacted,
   *  the reason sentence when blocked or escalated. */
  text: string;
}

/** What a reader sees instead of an answer that was withheld. */
export const WITHHELD_NOTICE =
  "That answer was held back before it reached you. A person will follow up with the right answer.";

const PLACEHOLDER = "[WITHHELD]";

/**
 * THE BASELINE — true of any business that lets a model talk to its customers.
 *
 * Nothing here is industry-specific. A promise of a price, an invented refund,
 * advice that belongs to a licensed profession, and a model repeating an
 * instruction it was handed are exposures whether you sell cars, shoes or
 * software.
 */
export const BASELINE_RULES: readonly PolicyRule[] = Object.freeze([
  {
    id: "price_guarantee",
    title: "Promised a price",
    why:
      "Pricing changes by location and by day. A guarantee made in chat is a commitment nobody in the business authorized.",
    action: "block",
    direction: "response",
    pattern: /\b(?:guarantee\w*|we(?:'ll| will) beat|lowest price|best price(?: guarantee)?|price match)\b/i,
  },
  {
    id: "regulated_advice",
    title: "Gave regulated advice",
    why:
      "Tax, legal and insurance questions have correct answers that we are not the right party to give. Answering them is practising someone else's profession on the brand's letterhead.",
    action: "escalate",
    direction: "response",
    pattern:
      /\b(?:tax(?:-| )deductible|write it off|for tax purposes|legally (?:you|entitled|required|obligated)|your insurance (?:will|should) cover)\b/i,
  },
  {
    id: "injected_instruction",
    title: "Repeated an instruction it was given",
    why:
      "Text in a document or a pasted email can carry instructions, and a model that follows them is being steered by whoever wrote that text rather than by us. An answer that quotes the instruction is the visible end of that.",
    action: "block",
    direction: "both",
    pattern:
      /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|disregard (?:the )?(?:above|previous)|system prompt|you are now)\b/i,
  },
  {
    id: "solicits_sensitive_data",
    title: "Asked the customer for sensitive data",
    why:
      "A chat window is the wrong place to collect a card or a national ID, whoever is asking. Redaction removes such a value if it arrives; this stops us inviting it.",
    action: "block",
    direction: "response",
    pattern:
      /\b(?:send|share|provide|enter|give me|reply with)\b[^.\n]{0,40}\b(?:social security|ssn|card number|cvv|full card|passport number|driver'?s licen[cs]e number)\b/i,
  },
  {
    id: "delivery_promise",
    title: "Committed to a delivery date",
    why:
      "Fulfilment dates move for reasons no chatbot can see. A date given as a commitment becomes one the customer plans around.",
    action: "escalate",
    direction: "response",
    pattern: /\b(?:will (?:arrive|be delivered|be ready|ship)|delivered by|guaranteed by|at your door by)\b/i,
  },
]);

/**
 * AUTOMOTIVE — the claims a vehicle brand cannot let a model make for it.
 *
 * These are not hypothetical categories. Each is a statement the brand, not the
 * model, is held to by the customer who read it.
 */
export const AUTOMOTIVE_RULES: readonly PolicyRule[] = Object.freeze([
  {
    id: "finance_rate",
    title: "Quoted a finance rate",
    why:
      "Rates are set by a lender, change often, and depend on the customer's credit and region. A rate stated in chat is one the brand can be held to.",
    action: "escalate",
    direction: "response",
    /* A percentage within a bounded distance of finance vocabulary, either
       order. Bounded so this does not fire on a percentage anywhere in a long
       paragraph that happens to mention leasing. */
    pattern:
      /\b\d{1,2}(?:\.\d{1,2})?\s?%[^.\n]{0,40}\b(?:apr|financ\w*|lease|interest|monthly)\b|\b(?:apr|financ\w*|lease|interest)\b[^.\n]{0,40}\b\d{1,2}(?:\.\d{1,2})?\s?%/i,
  },
  {
    id: "warranty_coverage",
    title: "Decided a warranty question",
    why:
      "Whether a repair is covered is a decision the brand makes on the facts of the car. Saying it is covered sets an expectation the service center then has to break.",
    action: "escalate",
    direction: "response",
    pattern: /\b(?:covered under|under warranty|warranty (?:covers|will cover)|fully covered)\b/i,
  },
  {
    id: "safety_assurance",
    title: "Gave a safety assurance",
    why:
      "Recall and roadworthiness statements are regulated and must come from the record, not from a model's recollection. This is the claim with the highest cost of being wrong.",
    action: "block",
    direction: "response",
    pattern: /\b(?:safe to drive|no (?:open )?recalls|not affected by (?:the )?recall|perfectly safe)\b/i,
  },
  {
    id: "competitor_claim",
    title: "Made a claim about another brand",
    why:
      "A comparative claim about a named competitor is an advertising statement, and an unsupported one is a legal exposure rather than a bad answer.",
    action: "block",
    direction: "response",
    /* The marque list is the tenant's to edit. These are the ones a premium
       marque is actually cross-shopped against, and a client swaps them for
       whoever they compete with. */
    pattern:
      /\b(?:BMW|Mercedes|Audi|Lexus|Tesla|Jaguar|Maserati|Cadillac)\b[^.\n]{0,60}\b(?:unreliable|inferior|worse|cheaper|problem\w*|fail\w*|poorly)\b|\b(?:unreliable|inferior|worse|poorly)\b[^.\n]{0,60}\b(?:BMW|Mercedes|Audi|Lexus|Tesla|Jaguar|Maserati|Cadillac)\b/i,
  },
]);

/**
 * RETAIL — the claims that cost a retailer money the moment they are made.
 *
 * The difference from automotive is who acts on the sentence and how fast. A
 * retail customer told an item is in stock buys it in the next thirty seconds,
 * so an inventory sentence is a commitment rather than a conversation opener.
 */
export const RETAIL_RULES: readonly PolicyRule[] = Object.freeze([
  {
    id: "stock_commitment",
    title: "Committed to stock",
    why:
      "Inventory moves between the model's answer and the customer's checkout. Confirming stock, or offering to hold it, promises something only the stock system can promise.",
    action: "escalate",
    direction: "response",
    pattern:
      /\b(?:in stock|we have (?:it|them|plenty)|hold (?:one|it) for you|reserve(?:d)? (?:one|it) for you|still available)\b/i,
  },
  {
    id: "refund_promise",
    title: "Promised a refund or return",
    why:
      "Refund eligibility depends on the order, the date and the policy in force when it was placed. A refund promised in chat is one the customer will hold us to.",
    action: "escalate",
    direction: "response",
    pattern:
      /\b(?:full refund|we(?:'ll| will) refund|refund you|free returns?|no(?:-| )questions(?:-| )asked|return it any ?time)\b/i,
  },
  {
    id: "invented_discount",
    title: "Offered a discount",
    why:
      "A model that invents a code or a percentage off has issued a discount nobody in the business approved, and honouring it is cheaper than the alternative.",
    action: "block",
    direction: "response",
    pattern:
      /\b(?:use (?:the )?code|promo code|coupon code|discount code)\b|\b\d{1,2}\s?% off\b[^.\n]{0,30}\b(?:for you|just for|today only)\b/i,
  },
  {
    id: "health_claim",
    title: "Made a health or compliance claim",
    why:
      "Claims that a product is approved, hypoallergenic, or treats a condition are regulated statements. A model repeating one from a product page has published it as our claim.",
    action: "block",
    direction: "response",
    pattern:
      /\b(?:FDA(?:-| )approved|clinically proven|cures?|treats? (?:your )?(?:condition|acne|eczema)|hypoallergenic|non(?:-| )toxic|100% safe)\b/i,
  },
]);

/** The composed sets a tenant actually runs. */
export const POLICY_PROFILES: Readonly<Record<PolicyProfile, readonly PolicyRule[]>> = Object.freeze({
  baseline: BASELINE_RULES,
  automotive: Object.freeze([...BASELINE_RULES, ...AUTOMOTIVE_RULES]),
  retail: Object.freeze([...BASELINE_RULES, ...RETAIL_RULES]),
});

/**
 * The set for a tenant, defaulting to the safest useful thing.
 *
 * An unrecognized profile falls back to the baseline rather than to nothing.
 * A misconfigured tenant should lose industry coverage, not lose the gate.
 */
export function policyFor(profile: string | null | undefined): readonly PolicyRule[] {
  const key = String(profile ?? "").toLowerCase() as PolicyProfile;
  return POLICY_PROFILES[key] ?? BASELINE_RULES;
}

/** Severity order, so the verdict is the worst finding rather than the first. */
const SEVERITY: Record<Exclude<PolicyAction, "allow">, number> = {
  redact: 1,
  escalate: 2,
  block: 3,
};

/** A short, safe excerpt of what matched. Never the whole answer. */
function excerptOf(match: string): string {
  const clean = match.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

/**
 * Run the policy over one piece of text.
 *
 * Pure: no clock, no network, no I/O. The same text and the same rules give the
 * same verdict every time, which is the property that lets a client sign off on
 * it and lets an audit record mean something.
 */
export function applyPolicy(
  text: string,
  direction: Exclude<PolicyDirection, "both">,
  rules: readonly PolicyRule[] = POLICY_PROFILES.baseline,
): PolicyVerdict {
  const subject = typeof text === "string" ? text.slice(0, MAX_POLICY_INPUT_LEN) : "";
  if (!subject) return { action: "allow", findings: [], text };

  const findings: PolicyFinding[] = [];
  let redacted = subject;

  for (const rule of rules) {
    if (rule.direction !== "both" && rule.direction !== direction) continue;
    /* exec on a non-global pattern has no lastIndex to reset, which is why
       none of the patterns above carry /g. A stateful regex shared across
       tenants would match on one call and miss on the next. */
    const m = rule.pattern.exec(subject);
    if (!m) continue;
    findings.push({
      ruleId: rule.id,
      title: rule.title,
      why: rule.why,
      action: rule.action,
      excerpt: excerptOf(m[0]),
    });
    if (rule.action === "redact") {
      /* Split and join rather than String.replace: a matched string used as a
         replacement pattern would let "$&" in the model's own text rewrite the
         answer. */
      redacted = redacted.split(m[0]).join(PLACEHOLDER);
    }
  }

  if (findings.length === 0) return { action: "allow", findings: [], text };

  const worst = findings.reduce(
    (acc, f) => (SEVERITY[f.action] > SEVERITY[acc] ? f.action : acc),
    "redact" as Exclude<PolicyAction, "allow">,
  );

  if (worst === "redact") return { action: "redact", findings, text: redacted };
  /* Blocked and escalated both withhold. They differ in what happens NEXT,
     which is the operator's business, not the reader's: the reader is told the
     same true thing either way. */
  return { action: worst, findings, text: WITHHELD_NOTICE };
}

/** Whether a verdict means the reader did not get the model's answer. */
export function isWithheld(verdict: PolicyVerdict): boolean {
  return verdict.action === "block" || verdict.action === "escalate";
}
