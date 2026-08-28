/**
 * Places a system disagrees with itself.
 *
 * WHY THIS IS ITS OWN CHECK. A scanner reports whether a page has a
 * protection. It does not report that eleven pages have it and one does not,
 * which is a different and often more useful fact. A missing header everywhere
 * is a decision somebody made; a missing header on one page out of twelve is
 * almost always an accident, and the accident is the thing worth telling a
 * client about.
 *
 * That is also what makes these cheap to act on. "Add a security header to
 * your estate" is a project. "This one route is missing the header the other
 * eleven have" is an afternoon, and it closes a real gap.
 *
 * INCONSISTENCY IS THE SIGNAL, NOT ABSENCE. Nothing here fires because a
 * protection is missing. It fires when the same system does two different
 * things, which is why it stays quiet on a site that has simply chosen not to
 * use a header and loud on one that lost it somewhere.
 *
 * Reads the observations the flow map already collected, so it costs no
 * additional requests against somebody else's production system.
 */

import type { PageObservation } from "./data-flow";

export interface Inconsistency {
  kind: "security_header" | "protection";
  /** What differs, in the reader's terms. */
  title: string;
  detail: string;
  /** The minority: the pages that differ from the rest. */
  outliers: string[];
  /** How many pages behaved the other way. */
  majorityCount: number;
}

/**
 * Headers whose presence on some pages and absence on others is a real gap.
 *
 * Short and precision-first. Each one is set per response, so a page missing
 * it genuinely was served differently, rather than the header being a
 * site-wide setting that simply does not apply here.
 */
const CONSISTENCY_HEADERS: ReadonlyArray<[header: string, label: string]> = [
  ["strict-transport-security", "the HTTPS-only instruction"],
  ["content-security-policy", "the content security policy"],
  ["x-content-type-options", "the content-type protection"],
  ["x-frame-options", "the clickjacking protection"],
];

/**
 * A page counts toward consistency only if it was actually served.
 *
 * A 404 has no obligation to carry a security policy, and counting one as a
 * gap produces a finding about a page that does not exist.
 */
function served(p: PageObservation): boolean {
  return p.status >= 200 && p.status < 400;
}

/** Below this there is no majority to be an outlier from. */
const MIN_PAGES = 4;
/**
 * How lopsided it has to be before a difference is an accident.
 *
 * At a quarter, four pages doing one thing and eight the other is two groups
 * rather than a mistake, and reporting it as an error would be wrong about the
 * system. One page in twelve is an accident.
 */
const MAX_OUTLIER_SHARE = 0.25;

export function findInconsistencies(
  pages: readonly PageObservation[] | undefined,
): Inconsistency[] {
  /* Tolerates an absent list rather than throwing. A map read back from an
     older record predates this field, and a consistency check that crashes on
     one is worse than a consistency check that says nothing about it. */
  const usable = (pages ?? []).filter(served);
  if (usable.length < MIN_PAGES) return [];

  const out: Inconsistency[] = [];

  for (const [header, label] of CONSISTENCY_HEADERS) {
    const withIt = usable.filter((p) => p.headerNames.includes(header));
    const without = usable.filter((p) => !p.headerNames.includes(header));

    /* All or nothing is consistent, whatever it says about the choice. This
       check is about disagreement, and a site that never sets a header has not
       disagreed with itself. */
    if (withIt.length === 0 || without.length === 0) continue;

    /* The minority is the outlier. Which side that is depends on the site, not
       on which one we would have preferred. */
    const minorityIsMissing = without.length <= withIt.length;
    const outliers = minorityIsMissing ? without : withIt;
    const majority = minorityIsMissing ? withIt : without;

    if (outliers.length / usable.length > MAX_OUTLIER_SHARE) continue;

    out.push({
      kind: "security_header",
      title: minorityIsMissing
        ? `${outliers.length} page${outliers.length === 1 ? " is" : "s are"} missing ${label}`
        : `${outliers.length} page${outliers.length === 1 ? " sets" : "s set"} ${label} when the rest do not`,
      detail: minorityIsMissing
        ? `${majority.length} other pages send this header and these do not, so the protection stops at the edge of whatever serves them.`
        : `Only these pages send this header, which usually means the protection was added in one place rather than across the site.`,
      outliers: outliers.map((p) => p.url),
      majorityCount: majority.length,
    });
  }

  return out;
}
