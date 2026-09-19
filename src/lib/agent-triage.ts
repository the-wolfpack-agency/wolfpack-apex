/**
 * Agent-journey triage: turn a flat list of correlated journeys into a
 * severity-ranked, grouped view so an operator triages threats first instead of
 * scrolling past benign crawlers and unclassified noise. Pure + generic over any
 * journey shape carrying a behavior class + a proven/inferred confidence, so it
 * works on the server summary and in the client identically.
 *
 * Severity from the behavior class:
 *   hostile  - aggressive_scraper / vuln_scanner / form_spammer: an actual
 *              attack pattern (harvest / recon / form abuse). Proven sorts above
 *              inferred within the bucket so confirmed actors are at the very top.
 *   elevated - suspicious: automation with weak signals, worth a glance.
 *   benign   - benign_crawler and unclassified: identified good crawlers and
 *              nothing-actionable. This is the noise a triage view should collapse.
 */

export type Severity = "hostile" | "elevated" | "benign";

export const SEVERITY_ORDER: Record<Severity, number> = { hostile: 0, elevated: 1, benign: 2 };

/** Behavior classes that are an actual attack pattern (not just automation). */
export const HOSTILE_CLASSES: ReadonlySet<string> = new Set(["exploit_attempt", "aggressive_scraper", "vuln_scanner", "form_spammer"]);

export interface TriageShape {
  behaviorClass: string;
  confidence: "proven" | "inferred";
  lastAt: string;
}

export function severityOf(j: TriageShape): Severity {
  if (HOSTILE_CLASSES.has(j.behaviorClass)) return "hostile";
  if (j.behaviorClass === "suspicious") return "elevated";
  return "benign";
}

export interface TriageCounts {
  total: number;
  hostile: number;
  elevated: number;
  benign: number;
  proven: number;
  inferred: number;
}

export interface TriageBuckets<T extends TriageShape> {
  hostile: T[];
  elevated: T[];
  benign: T[];
  counts: TriageCounts;
}

/** Group + rank journeys. Within each severity: proven before inferred, then
 *  most-recent first. Deterministic. */
export function triageJourneys<T extends TriageShape>(journeys: readonly T[]): TriageBuckets<T> {
  const buckets: { hostile: T[]; elevated: T[]; benign: T[] } = { hostile: [], elevated: [], benign: [] };
  const counts: TriageCounts = { total: 0, hostile: 0, elevated: 0, benign: 0, proven: 0, inferred: 0 };

  for (const j of journeys) {
    const sev = severityOf(j);
    buckets[sev].push(j);
    counts.total += 1;
    counts[sev] += 1;
    if (j.confidence === "proven") counts.proven += 1;
    else counts.inferred += 1;
  }

  const rank = (a: T, b: T) => {
    if (a.confidence !== b.confidence) return a.confidence === "proven" ? -1 : 1;
    return b.lastAt.localeCompare(a.lastAt);
  };
  buckets.hostile.sort(rank);
  buckets.elevated.sort(rank);
  buckets.benign.sort(rank);

  return { ...buckets, counts };
}
