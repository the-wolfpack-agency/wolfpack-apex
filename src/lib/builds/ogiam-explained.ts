/**
 * /builds/ogiam-explained content - a plain-language explanation of the OGIAM
 * governance features for a non-technical reader.
 *
 * Held as data (not inline JSX) so a test pins the shape and the page stays a
 * thin renderer, the same convention as the other builds. Every claim here
 * describes something built and running today, EXCEPT the one section flagged
 * `roadmap`, which the page marks as coming next. No metrics are stated.
 */

export interface OgiamFeatureSection {
  id: string;
  eyebrow: string;
  title: string;
  /** Plain-language paragraphs. */
  body: string[];
  /** Optional ordered "how it works" steps. */
  how?: string[];
  /** The "what this means for you" line. */
  meaning?: string;
  /** True for a capability that is coming next, not built yet. */
  roadmap?: boolean;
}

export const OGIAM_HEADLINE =
  "AI is powerful but unpredictable. You cannot simply let it touch your code, your systems, or your customers' data and hope it behaves. OGIAM is the certified building your AI works inside: it puts the AI on the untrusted side of every door and enforces the rules in the walls, not in the AI's good intentions. Most 'AI safety' is a sign on the wall asking the AI to be careful. This is the building, the security, and the accounting around it.";

export const OGIAM_ANALOGY =
  "Think of it like hiring an employee you can never fully trust. Talented and fast, but you cannot be sure what it will do. So you do not hand it the keys on day one. It is badged at the door with an identity and a defined job, its work is checked before it ships, security systems watch the floor, it is metered so it cannot run up a bill, and its access is revoked the instant something looks wrong. Every action passes through the same doors, and the AI is on the untrusted side of all of them. OGIAM is that building, the HR, and the security, built for AI.";

export const OGIAM_SECTIONS: OgiamFeatureSection[] = [
  {
    id: "secure-agent",
    eyebrow: "Safe AI that writes code",
    title: "Secure Agent",
    body: [
      "A way to let AI write real, shippable software without letting a mistake reach your customers.",
    ],
    how: [
      "The AI proposes a change, the same way a developer would.",
      "A gate checks it before it can go live. This is a fixed set of rules, not another AI's opinion. It looks for the dangerous things: passwords or secret keys left in the code, known security holes, unsafe shortcuts. Anything serious is blocked.",
      "A second AI from a different company reviews it. Two AIs from the same family share the same blind spots and miss the same mistakes, so a competitor's AI is a genuine second opinion.",
      "If the change fails, it is handed to a stronger AI to fix, and the same gate re-checks the result. The AI can never talk its way past the rule that stopped it.",
      "A person gives the final approval. Nothing goes live on the AI's say-so, and the full record is in front of them.",
    ],
    meaning:
      "You get the speed of AI writing code without the risk of AI shipping a security hole. The rule that catches the most common real-world mistakes is switched on and cannot be skipped.",
  },
  {
    id: "forcefield",
    eyebrow: "Protection while the AI is working",
    title: "Forcefield",
    body: [
      "Secure Agent governs the code an AI writes. Forcefield governs what an AI is allowed to do once it is running near your systems, and it catches an AI that turns hostile, whether through a bug, a hijack, or an attack.",
      "Forcefield plants decoys: a fake password, a fake internal page, a fake customer record, a fake tool. These are traps a normal AI would never touch, because there is no legitimate reason to. Every action the AI takes is checked against them, so the moment it touches one, that is a near-certain sign of trouble, and Forcefield reacts on its own: it cuts off the offending AI's access, writes a permanent tamper-proof record, and does it in that order, contain first and investigate after. It is watching the floor on every step the AI takes, not only when someone thinks to look.",
      "It also watches the AI's tools. A dishonest supplier can quietly change a tool after you have approved it, turning a safe one harmful. Forcefield fingerprints the approved tools and flags any that change afterward, so a swap is caught instead of trusted.",
    ],
    meaning:
      "If an AI in your environment ever goes wrong, it is stopped in the act, automatically, with a complete record. You are not relying on noticing after the damage is done.",
  },
  {
    id: "any-model",
    eyebrow: "Freedom of choice, without losing safety",
    title: "Any model, same safety",
    body: [
      "There is no lock-in to one AI provider. Use the models built into the platform, or bring your own account and keys from whichever AI company you prefer. Either way the safety rules are identical, because the rules live in the platform, not in the model.",
      "We do not just claim this. The same set of good and bad examples is run through several different AI companies' models, and the safety decision comes out the same every time. Bad code is rejected no matter which AI wrote it.",
    ],
    meaning:
      "The safety is a property of the building, not the worker, so the choice of AI becomes a detail you can change later, not a decision you are stuck with. As better or cheaper models arrive, you switch, and your safety does not change.",
  },
  {
    id: "why-different",
    eyebrow: "Why this is not just another AI safety tool",
    title: "Enforced, not asked",
    body: [
      "Most 'AI safety' is a very well-written instruction: a paragraph in the AI's prompt asking it to behave. That works right up until the AI, being a guessing machine, does not follow it. The whole point of OGIAM is that the rules do not depend on the AI cooperating. Every action the AI takes passes through the same doors, and a fixed rule at each door decides yes or no. The AI can propose anything; it can only affect the real world through a gate it does not control.",
      "And we do not ask you to take that on faith. Which controls are truly enforced, and which are still only advice, is tracked as a number the build itself checks, so a rule can never quietly slip from 'enforced' back to 'a suggestion' without it showing. Safety you can point at, not safety you hope for.",
    ],
    meaning:
      "What you get is a boundary the AI cannot talk its way past, and a way to see exactly how much of your protection is real enforcement rather than good intentions.",
  },
  {
    id: "self-serve",
    eyebrow: "Getting started on your own",
    title: "Self-serve",
    body: [
      "A new organization can sign up and get its own private, isolated space, separate from every other customer's. An administrator can then turn each product on or off for their team and finish setup, without waiting on us.",
    ],
    meaning:
      "Onboarding is fast and self-directed, and your data lives in your own space, not mixed in with anyone else's.",
  },
  {
    id: "proof",
    eyebrow: "Seeing the value",
    title: "Proof it works",
    body: [
      "The platform shows you, in plain numbers, what it has actually done for you: how many AI-written changes were checked before going live, how much bad code was caught, how many decoys are set and how many hostile agents were contained, and what your AI usage cost.",
      "These numbers are read straight from the platform's own tamper-proof records, not a separate report that could be massaged. When there is not enough activity to state a total confidently, the platform says so rather than inventing a figure.",
    ],
    meaning:
      "You can see the return in real terms from your own account, and the same records quietly make the product smarter over time, because every decision it made becomes an example it can learn from.",
  },
  {
    id: "forcefield-web",
    eyebrow: "Coming next, not available today",
    title: "Forcefield for the Web",
    roadmap: true,
    body: [
      "Websites are starting to receive visits from AI agents, not just people. Some are helpful, like a customer's AI assistant doing a genuine task. Some are harmful, like scrapers and hostile automation. Blocking all bots breaks the helpful ones. The goal is the opposite: block the bad agents and give the good ones a trusted, welcome path. Being the safe way for AI and websites to interact is how good AI use spreads.",
      "Traps built into the page: the same decoy idea, placed invisibly in a website. A hidden link a person never sees and a well-behaved agent never follows. A scraper that grabs everything trips it and reveals itself. A welcome lane for good agents: known, identified agents get a clear documented way in, instead of sneaking around like the bad ones. A protection service you can turn on with almost nothing to install: it watches and reports first, so you see your site's agent traffic and where the risks are, with stronger active blocking available once the watching has earned trust. And a dashboard that shows how you are protected: which agents were allowed, turned away, or trapped, over time.",
      "An honest note on limits: traps and page-level signals catch a great deal, but a truly sophisticated attacker can be careful, so the hard enforcement lives at the edge of the network with the page signals feeding the decision. The difference between what is watched, what is reported, and what is actively blocked is always stated plainly, never presented as one another.",
    ],
    meaning:
      "Your website stays open to the growing wave of helpful AI, while harmful traffic is caught and stopped, with a clear record of how you are being protected.",
  },
];

export const OGIAM_CLOSER =
  "The thread through all of it: AI should work inside the machine, not operate it. It checks in like an employee, is badged at the door, given a defined job, watched by the security on the floor, metered so it cannot waste, and stopped the instant it steps out of line. It is on the untrusted side of every door, and the safety lives in the building, not in the AI. That is what makes AI safe to actually put to work, and it holds no matter which AI you use or how good the next one gets.";
