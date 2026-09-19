/**
 * Pages that belong to a client engagement rather than to Instinct.
 *
 * WHY THE SECTION EXISTS. Phase One lived at /pilot, in the same nav as
 * Assistant and Search, styled like everything else. Nothing on the screen said
 * it was work in flight for one client rather than a feature of the product,
 * and the only person who knew was whoever built it. A page that cannot be told
 * apart from the shipped product will eventually be demoed as the shipped
 * product.
 *
 * THE DISTINCTION THAT MATTERS MOST IS NOT WHICH CLIENT. It is what on the page
 * is real. A wireframe and a working surface look identical in a screenshot,
 * and the difference is the whole meaning of the demo. So every build states
 * what its numbers are, in its own words, and the banner puts that sentence on
 * the page rather than leaving it in somebody's head.
 *
 * This is the register both the section index and the banner read, so a build
 * cannot be listed in one and missing from the other.
 */

export type BuildStage =
  /** Drawn, not wired. Nothing on the page is measured. */
  | "concept"
  /** Some of it runs against real data. The build says which parts. */
  | "in flight"
  /** Running for the client. Kept here because it is still engagement work. */
  | "live";

export interface ClientBuild {
  /** Path under /builds, or an existing path for a page built before this. */
  href: string;
  title: string;
  /** Who it is for. "Wolfpack" when we are the client, which is honest. */
  client: string;
  stage: BuildStage;
  /** One sentence a colleague could read cold. */
  what: string;
  /**
   * What the numbers on the page ARE.
   *
   * The single most important field here, and the reason the register exists
   * rather than a folder convention. "Measured against our own Microsoft
   * tenant" and "drawn from a document, nothing is wired" produce identical
   * screenshots and opposite conversations.
   */
  data: string;
}

export const CLIENT_BUILDS: ClientBuild[] = [
  {
    href: "/pilot",
    title: "Phase One",
    client: "Wolfpack, standing in for the first client",
    stage: "in flight",
    what: "What a documents-and-mail deployment looks like in its first weeks: what got asked, what could not be answered, and what never reaches a model.",
    data: "Every figure is measured against our own Microsoft tenant and query log. Nothing on the page is illustrative.",
  },
  {
    href: "/builds/insight-scan",
    title: "Results against plan",
    client: "Wolfpack, on our own indexed corpus",
    stage: "in flight",
    what: "What a dataset scan should look like: actions for one team, each carrying the gap it closes, the records under it, and what would make it wrong.",
    data: "Measured live against 5,257 evaluation records in the indexed corpus. The plan it compares against is illustrative and ours, and the page says so.",
  },
  {
    href: "/builds/course-program",
    title: "New course, new client",
    client: "Wolfpack, for a client not yet named",
    stage: "concept",
    what: "Taking the method behind the Brand Ambassador program to a new client: the commitment ladder transfers, the materials do not.",
    data: "Read from their own facilitator guides, cohort surveys and coaching scripts in the indexed corpus. Nothing is wired, and the client has not been named.",
  },
  {
    href: "/builds/security-plain-language",
    title: "Take the gates down",
    client: "Palo Alto Networks (prospective, not engaged)",
    stage: "concept",
    what: "A plain-language product certification for everyone Palo Alto's engineer-only training leaves out (sales, success, marketing, ops): what each product does in human terms, built on our proven Brand Ambassador change-management method.",
    data: "Illustrative. Every product description is written from public knowledge of Palo Alto's products, not from any Palo Alto material, and nothing on the page is measured. Palo Alto is not a client; this is a sample of the method.",
  },
  {
    href: "/builds/change-management",
    title: "Change Management Plan",
    client: "Porsche Academy US",
    stage: "concept",
    what: "A replacement for the form-builder change management plan: the same exercise, held as a record that lives past the day it was written.",
    data: "Drawn from their training material and a read-only walk of the current tool. Nothing is wired, and the plan's own fields have not been read yet.",
  },
  {
    href: "/builds/ogiam-explained",
    title: "OGIAM, in plain language",
    client: "Wolfpack (OGIAM product pre-build, ahead of its own repo)",
    stage: "in flight",
    what: "A plain-language explanation of OGIAM's governance features for a non-technical reader: Secure Agent, Forcefield, any-model safety, self-serve, proof it works, and what is coming next.",
    data: "The capabilities described are built and running in Instinct today; this page stages OGIAM as its own product ahead of standing up a dedicated repo. The 'Forcefield for the Web' section is explicitly marked as coming next, and no metrics are shown on the page.",
  },
  {
    href: "/builds/agent-intelligence",
    title: "Agent Intelligence, in plain language",
    client: "Wolfpack (Agent-intelligence pre-build, ahead of its own repo)",
    stage: "in flight",
    what: "A plain-language explanation of the agent behavioral-intelligence capability: welcome the good agents, trap the bad, follow the whole visit, fingerprint the scaffolding not the model, read intent from the toolset, and fuse it into an operator dossier - plus the model test-bench.",
    data: "Every capability described is built and running in Instinct today (honeypot, classifier, journeys, scaffolding harness, tool-composition, operator dossier, and the live model-probe runner + console). The operators board persists sightings over time into per-operator dossiers. Secret-safe: no trap paths, probe lists, or fingerprint mechanics; no metrics.",
  },
  {
    href: "/builds/governance-posture",
    title: "Governance posture",
    client: "Wolfpack (OGIAM, client-presentable)",
    stage: "live",
    what: "The client-facing 'how governed is your AI' surface: which controls are enforced automatically, which need a person, and which are human-reviewed, plus the proofs.",
    data: "The control lists are read LIVE from the platform's own control registry (the same one CI ratchets), so the page cannot claim more than is actually enforced. The real usage numbers live on the linked Effectiveness view; none are shown here.",
  },
];

export function buildFor(pathname: string): ClientBuild | undefined {
  return CLIENT_BUILDS.find((b) => b.href === pathname);
}
