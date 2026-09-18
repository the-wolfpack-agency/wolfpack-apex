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
  "AI is powerful but unpredictable. You cannot simply let it touch your code, your systems, or your customers' data and hope it behaves. OGIAM makes AI safe to use by putting it inside a set of rules it cannot break, enforced by the platform rather than trusted to the AI's good intentions.";

export const OGIAM_ANALOGY =
  "Think of it like a new employee. Talented and fast, but new. You do not hand a new hire the keys to everything on day one. You give them a badge, a defined job, a manager who checks their work before it ships, and the ability to revoke access the moment something looks wrong. OGIAM is that structure, built for AI.";

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
      "Forcefield plants decoys: a fake password, a fake internal page, a fake customer record, a fake tool. These are traps a normal AI would never touch, because there is no legitimate reason to. So the moment anything touches one, that is a near-certain sign of trouble, and Forcefield reacts on its own: it cuts off the offending AI's access, writes a permanent tamper-proof record, and does it in that order, contain first and investigate after.",
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
      "The choice of AI becomes a detail you can change later, not a decision you are stuck with. As better or cheaper models arrive, you switch, and your safety does not change.",
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
  "The thread through all of it: AI should work inside the machine, not operate it. It checks in like an employee, is given a defined job, plays by the platform's rules, is watched, and can be stopped. That is what makes AI safe to actually put to work, and it holds no matter which AI you use or how good the next one gets.";
