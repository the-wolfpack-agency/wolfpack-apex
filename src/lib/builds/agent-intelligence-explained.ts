/**
 * /builds/agent-intelligence - a plain-language explanation of the agent
 * behavioral-intelligence capability (Forcefield for the Web + following the
 * agent + attribution), staged as a pre-build ahead of its own repo so the
 * design and copy can be ported over when the product is stood up.
 *
 * WHAT IS REAL HERE. Every capability described is built and running in the
 * platform today (honeypot + classifier + journeys + scaffolding harness +
 * tool-composition + operator dossier + the live model-probe runner and its
 * console). Only the "operators board over time" note is marked as coming next.
 * No metrics are shown. Secret-safe: no exact trap paths, probe lists, or
 * fingerprint mechanics are stated - enough to interest, never an evasion manual.
 * Content lives as data (a test pins the shape) so the page stays a thin renderer.
 */

import type { OgiamFeatureSection } from "@/lib/builds/ogiam-explained";

export const AGENT_INTEL_HEADLINE =
  "Websites are visited by AI agents now, not only people. Some are helpful; some are hostile. Most defenses ask one blunt question, bot or human, from a label the bad ones fake. We ask a better one: across a whole visit, how did it behave, how is it built, and what is it equipped to do? Behavior is far harder to fake than a name, and it points at the operator behind the agent, not just the tool.";

export const AGENT_INTEL_ANALOGY =
  "Think of a shop with a very good floor detective. Anyone can wear a uniform and claim to be staff. The detective does not go by the uniform; they watch how a person moves through the shop, what they reach for, whether they try the locked doors. A regular customer and a shoplifter behave differently, and the difference is what gives them away, whatever they are wearing. This is that detective, for AI agents on the open web.";

export const AGENT_INTEL_SECTIONS: OgiamFeatureSection[] = [
  {
    id: "welcome-lane",
    eyebrow: "Tell the good from the bad",
    title: "A welcome lane, and a trap",
    body: [
      "Known, well-behaved agents (the major search and AI crawlers) are recognized and given a clear, trusted path, instead of being blocked along with everything else. Blocking all bots breaks the helpful ones; the goal is the opposite.",
      "For the rest, an invisible decoy sits in the page that a person never sees and a well-behaved agent never follows, because the site's own rules tell it not to. An agent that ignores the rules and springs the trap has, with near-certainty, shown its hand.",
    ],
    meaning:
      "The helpful agents get a smooth path; the hostile ones reveal themselves. Nothing legitimate is turned away.",
  },
  {
    id: "following",
    eyebrow: "Follow the whole visit",
    title: "One event is noise; a path is a signature",
    body: [
      "A single request tells you little. We stitch a visitor's whole journey together, so a pattern becomes visible: did it read the rules first, did it wander the links, did it go hunting for an admin page or a login it was never shown?",
      "The path an agent takes across a visit is a behavior signature, and behavior is much harder to disguise than the name it announces itself with.",
    ],
    meaning:
      "You see intent as a shape over a whole visit, not a guess from one hit.",
  },
  {
    id: "scaffolding",
    eyebrow: "Read how it is built",
    title: "The tell is the scaffolding, not the model",
    body: [
      "An AI agent is a model wrapped in scaffolding: the thing that fetches pages, decides where to go next, retries when blocked. The model is the interchangeable part. The scaffolding is the operator's own choice, and it leaves the more durable trace.",
      "Two operators running the same model behave differently; one operator keeps behaving the same way even after swapping models. So the fingerprint that matters for both detection and attribution lives in the scaffolding, and that is what we read.",
    ],
    meaning:
      "You fingerprint the operator's tooling, which persists, rather than the model, which they can change at will.",
  },
  {
    id: "tools",
    eyebrow: "Read what it is for",
    title: "Intent from the toolset",
    body: [
      "The tools an agent is equipped with are one of the most honest signals of intent there is. A model can be told to sound harmless, but a toolset that pairs a password list with a login-attempt tool is doing credential stuffing whatever it claims.",
      "Certain combinations have no legitimate purpose on someone else's site, and the combination is the tell. A novel, unusual toolchain is also a durable marker of a particular operator.",
    ],
    meaning:
      "You judge intent by what an agent is built to do, not only by what it says or does in one moment.",
  },
  {
    id: "dossier",
    eyebrow: "Turn it into evidence",
    title: "One operator, one dossier",
    body: [
      "Behavior, scaffolding, and toolset are fused into a single record keyed to a consistent operator, correlated across the surfaces we protect. The result is a clear, checkable account: this operator, this behavior, this tooling, seen here.",
      "It is honest about its limits. It attributes behavior to a consistent operator profile. It does not claim a real-world identity, which requires legal process, and it says so plainly on every dossier. It is the evidence you hand a security team or an investigator, not an accusation.",
    ],
    meaning:
      "You get attribution-grade evidence you can act on, without overclaiming what it proves.",
  },
  {
    id: "prove-it",
    eyebrow: "Test it yourself",
    title: "Point any model at it and watch",
    body: [
      "The same reading that runs on live traffic also runs as a test bench: point any model at the site, give it a goal, and watch how it behaves, welcomed, probing, or hostile, with the operator dossier produced at the end.",
      "It is model-agnostic on purpose, so different AI models and frameworks can be run side by side against the same site and compared. When a tool is offered to the agent, only harmless ones ever act; the dangerous ones are decoys, so what the agent WANTS to do is revealed with no real harm done.",
    ],
    meaning:
      "You can prove the capability on demand, and compare how different AI behaves, on your own infrastructure.",
  },
  {
    id: "honest",
    eyebrow: "Honest by construction",
    title: "Proven versus likely, never blurred",
    body: [
      "When an agent gives itself away with certainty, by tripping a trap only a bot could trip, or exercising a hostile toolset, that is marked proven. When it is grouped by a coarser signal, that is marked likely, and never dressed up as proof.",
      "And it watches before it acts: it reports first, so a site sees its agent traffic and where the risk is before anything is ever turned away. A careful, patient adversary can still blend in; this catches the broad middle, and says so.",
    ],
    meaning:
      "You always know which of your protection is proven and which is a likely read, and nothing is ever quietly overstated.",
  },
  {
    id: "operators-over-time",
    eyebrow: "Coming next, not available today",
    title: "The operators board over time",
    roadmap: true,
    body: [
      "Today each reading and dossier is produced on demand. The next step is to keep them over time, so the same operator seen across many visits and many sites builds into a persistent profile, and a board shows the operators active against your surfaces, ranked by threat, with their history.",
    ],
    meaning:
      "A living map of the operators targeting you, not just a snapshot of one visit.",
  },
];

export const AGENT_INTEL_CLOSER =
  "The thread through all of it: you cannot trust what an agent says it is, but you can read what it does, how it is built, and what it is for, across a whole visit and across your surfaces. That is a far harder thing to fake, it points at the operator rather than the disposable tool, and it is honest about the line between proven and likely. It is a new way to see the AI agents on the open web, and to keep the people behind the good ones welcome while the bad ones give themselves away.";
