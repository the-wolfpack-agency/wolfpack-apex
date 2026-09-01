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
    href: "/builds/change-management",
    title: "Change Management Plan",
    client: "Porsche Academy US",
    stage: "concept",
    what: "A replacement for the form-builder change management plan: the same exercise, held as a record that lives past the day it was written.",
    data: "Drawn from their training material and a read-only walk of the current tool. Nothing is wired, and the plan's own fields have not been read yet.",
  },
];

export function buildFor(pathname: string): ClientBuild | undefined {
  return CLIENT_BUILDS.find((b) => b.href === pathname);
}
