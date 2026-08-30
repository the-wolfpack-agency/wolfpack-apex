/**
 * Which outside companies a system sends data to, and from which screens.
 *
 * ObservedIntegration has been declared in types.ts since the mapper was
 * written and populated nowhere, the same way InferredEntity was. Every map
 * reported zero integrations regardless of what the system contacted.
 *
 * NOTHING NEW IS CLASSIFIED HERE. network/observations.ts already decides what
 * is first-party, what is a subdomain, what is a third party, and which hosts
 * are recognisable vendors, and it is pure and tested. This groups its output
 * by host and attaches the screens, which is the only part the map needs and
 * the classifier does not do.
 *
 * WHY BY SCREEN AND NOT JUST BY HOST. "This system talks to an analytics
 * vendor" is worth little in an assessment. "The entries export screen talks
 * to an analytics vendor" tells somebody which part of their business is
 * involved, and that is the difference between a finding and a fact.
 *
 * UNRECOGNISED IS NOT BENIGN. A host nobody recognises keeps a null vendor and
 * is reported exactly like the rest. On somebody else's system the hosts we
 * cannot name are the ones most worth asking about, and dropping them would
 * make an unfamiliar system look cleaner than a familiar one.
 */

import { classify, hostOf, type NetworkObservation } from "../network/observations";
import type { ObservedIntegration } from "./types";

/**
 * Group third-party traffic into one entry per host.
 *
 * Subdomains of the system itself are excluded: a static asset host belonging
 * to the same company is not an integration, and listing it would bury the
 * ones that are.
 */
export function observedIntegrations(observations: NetworkObservation[]): ObservedIntegration[] {
  const byHost = new Map<string, { vendor: string | null; seenOn: Set<string>; count: number }>();

  for (const obs of observations) {
    const c = classify(obs);
    if (c.party !== "third-party" || !c.host) continue;

    const entry = byHost.get(c.host) ?? { vendor: c.vendor, seenOn: new Set<string>(), count: 0 };
    entry.count += 1;
    /* A screen is recorded once however many requests it made to the host, so
       seenOn answers "where" and requestCount answers "how much". Conflating
       them would make one chatty screen look like broad usage. */
    if (obs.pageUrl) entry.seenOn.add(obs.pageUrl);
    /* First recognised name wins: identify() is deterministic, so this only
       matters when an earlier observation had an unparseable URL. */
    entry.vendor ??= c.vendor;
    byHost.set(c.host, entry);
  }

  return [...byHost.entries()]
    .map(([host, e]) => ({
      host,
      vendor: e.vendor,
      seenOn: [...e.seenOn].sort(),
      requestCount: e.count,
    }))
    /* Most-contacted first, then named before unnamed, so the list opens with
       what a reader can act on. */
    .sort(
      (a, b) =>
        b.requestCount - a.requestCount ||
        Number(b.vendor !== null) - Number(a.vendor !== null) ||
        a.host.localeCompare(b.host),
    );
}

/**
 * One sentence about where data goes, or an honest statement that we cannot say.
 *
 * A map that observed nothing must not read like a map that observed nothing
 * happening. The two are the same sentence in most tools and they are opposite
 * findings: one is a clean system, the other is a scan that was not watching.
 */
export function describeIntegrations(
  integrations: ObservedIntegration[],
  observed: boolean,
): string {
  if (!observed) {
    return "Outbound traffic was not recorded during this walk, so nothing can be said about which outside services this system contacts. That is a gap in the scan, not a clean result.";
  }
  if (integrations.length === 0) {
    return "No third-party hosts were contacted on any screen that was opened.";
  }
  const named = integrations.filter((i) => i.vendor !== null);
  const unnamed = integrations.length - named.length;
  const head = named
    .slice(0, 5)
    .map((i) => i.vendor)
    .join(", ");
  const parts = [`${integrations.length} third-party host(s) contacted`];
  if (named.length > 0) parts.push(`including ${head}`);
  if (unnamed > 0) {
    parts.push(
      `${unnamed} unrecognised, which are the ones worth asking about rather than the ones to ignore`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** Re-exported so callers need one import to go from a URL to a host. */
export { hostOf };
