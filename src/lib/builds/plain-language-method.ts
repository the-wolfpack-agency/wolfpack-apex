/**
 * The plain-language method, client-neutral. This is the reusable change-management
 * engine underneath the Palo Alto certification build, lifted out of the Palo Alto
 * specifics so it can be pointed at ANY client's products.
 *
 * WHY THIS EXISTS SEPARATELY. A method that only lives inside one client's build is
 * a one-off. Held here, on its own, it is an asset: the four beats, the ladder, the
 * field-deployment track, and the recipe for applying it are all client-neutral;
 * only the product explanations change per client. The Palo Alto build
 * (/builds/security-plain-language) is one worked example of this method.
 *
 * WHAT IS REAL: the method itself is proven (the Brand Ambassador change-management
 * program). What is presented here client-neutral is the generalization; nothing on
 * the page is measured. A test pins the shape.
 */

/** The core move, applied to any product, feature, or acquisition. */
export const METHOD = [
  { beat: "Name the jargon", does: "Say the acronym or term out loud, plainly, so nobody has to pretend they already knew it." },
  { beat: "Say what is happening", does: "Describe, in words a non-expert can repeat, what the thing actually does." },
  { beat: "What it stops", does: "State the specific bad thing it prevents." },
  { beat: "What happens without it", does: "Name the outcome being avoided, so the value is felt, not asserted." },
] as const;

/** The capability ladder, client-neutral. Roles vary per client; the shape does not. */
export const LADDER = [
  { tier: "Foundations", who: "Every non-technical employee", proves: "Can say, in plain words, what a product does, what it stops, and what would happen without it, without reaching for an acronym." },
  { tier: "Practitioner", who: "Customer-facing roles (sales, success, support)", proves: "Can map a customer's actual problem to the right product and explain the value in the customer's own terms, objections included." },
  { tier: "Ambassador", who: "Team leads and enablement", proves: "Can teach it and keep it current, running the four beats on every new feature and acquisition so fluency does not decay as the portfolio grows." },
];

/** The highest-value, least-trained audience in any technical company. */
export const FIELD_TRACK = {
  role: "Field / forward-deployed roles",
  why: "The people deployed into a customer's environment have cleared every technical gate and now have to open them for the customer, under pressure, with almost no training for that half of the job.",
  covers: [
    "Product depth, told plainly",
    "Translation and handling the room",
    "Mapping the capability to the customer's system",
    "Driving adoption at the deployment site so it sticks after they leave",
  ],
};

/** The insight the whole method rests on. Already client-neutral. */
export const GATEKEEPING =
  "Jargon does not just confuse; it gatekeeps, and the gates only ever open inward. Specialists guard knowledge, and the moment someone clears the gate they start speaking the same jargon, because that is how expertise is signaled. Without real understanding, nobody can compare tools, improve a process, or grasp what the company does and sells. Taking the gates down, precisely and without dumbing anything down, is the whole point.";

/** What it reuses from the proven change-management program. Client-neutral. */
export const REUSES = [
  { have: "The commitment ladder", serves: "becomes the certification structure: each tier is a capability certified against, not a class attended." },
  { have: "Follow-through coaching", serves: "becomes the reinforcement that keeps fluency from fading after the training day." },
  { have: "Adoption measurement", serves: "becomes the proof it changed how people sell and speak, not just that they passed a quiz." },
  { have: "The wolfpack-lms assistant-guided coursework", serves: "becomes the tutor that walks each person through their tier and reinforces it over time." },
];

/** The recipe for pointing the engine at any client. This is what makes it reusable. */
export const APPLY = [
  { step: "Take the client's own products, features, and acquisitions.", why: "The content is the only client-specific part; everything else is the method." },
  { step: "Run the four beats, in their words.", why: "Read their decks and calls so the language matches how their teams already talk, and the corrections come from them." },
  { step: "Build the ladder for their roles.", why: "The tiers are fixed; who fills them is the client's org." },
  { step: "Add the field / deployment track.", why: "For the customer-facing technical roles, the same method as an operating skill." },
  { step: "Deliver through the assistant, with reinforcement.", why: "So it sticks past the training day rather than fading in a month." },
  { step: "Measure adoption and behavior change.", why: "Baseline first, then prove it moved how people actually work." },
];

/** Where the engine has been (or will be) pointed. Honest about which is real. */
export const WORKED_EXAMPLES = [
  { client: "Palo Alto Networks (prospective)", where: "/builds/security-plain-language", note: "The full worked example: their product line, two feature-level deep dives, the acquisitions, the ladder, and the field track." },
  { client: "Any technical vendor or enterprise", where: null, note: "Point it at a dealer-tools rollout, a platform, or any dense product a non-technical workforce has to understand and sell." },
];
