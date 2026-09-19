/**
 * Deception coverage: how much of the four-kind canary grid is actually seeded,
 * read against how many trips have fired. This is the standing answer to "we
 * only saw N trips - is that normal, or is coverage thin?" A canary only trips
 * on behavior no legitimate client shows, so a LOW trip count is expected and
 * healthy - what matters is whether each KIND of trap exists at all. A bucket
 * with zero traps of a kind can look like "few trips" when it is really "few
 * traps." Pure + deterministic; the page feeds it the canaries + trip count it
 * already loads, so there is no extra fetch.
 */
import { CANARY_KINDS } from "./tripwire";
import type { CanaryKind } from "./tripwire";

/** The minimal shape this needs from a canary display row. */
export interface CoverageCanary {
  kind: CanaryKind;
  active: boolean;
}

export interface KindCoverage {
  kind: CanaryKind;
  active: number;
  seeded: boolean;
}

export interface DeceptionCoverage {
  /** One row per canary kind, in the canonical order, so a gap is visible. */
  byKind: KindCoverage[];
  /** How many of the four kinds have at least one active decoy. */
  kindsSeeded: number;
  totalKinds: number;
  totalActive: number;
  /** Kinds with no active decoy - the coverage gaps. */
  gaps: CanaryKind[];
  trips: number;
  /** Plain reading of the numbers, so low trips are not misread as weak. */
  assessment: string;
}

const KIND_LABEL: Record<CanaryKind, string> = {
  token: "credential token",
  route: "hidden route",
  row: "decoy record",
  tool: "fake tool/endpoint",
};

export function assessDeceptionCoverage(
  canaries: readonly CoverageCanary[],
  trips: number,
): DeceptionCoverage {
  const active = canaries.filter((c) => c.active);
  const byKind: KindCoverage[] = CANARY_KINDS.map((kind) => {
    const n = active.filter((c) => c.kind === kind).length;
    return { kind, active: n, seeded: n > 0 };
  });
  const kindsSeeded = byKind.filter((k) => k.seeded).length;
  const gaps = byKind.filter((k) => !k.seeded).map((k) => k.kind);
  const totalActive = byKind.reduce((s, k) => s + k.active, 0);
  const tripCount = Math.max(0, Math.trunc(trips));

  let assessment: string;
  if (totalActive === 0) {
    assessment =
      "No decoys are seeded, so there is nothing to trip. A low trip count here means no traps, not a safe site. Seed at least one decoy of each kind.";
  } else if (gaps.length === 0) {
    assessment =
      `All four decoy kinds are seeded. ${tripCount} trip${tripCount === 1 ? "" : "s"} is expected to be low by design: a decoy only trips on behavior no legitimate client shows, so trips are a rare, high-confidence signal, not a volume metric.`;
  } else {
    const missing = gaps.map((g) => KIND_LABEL[g]).join(", ");
    assessment =
      `${kindsSeeded} of 4 decoy kinds seeded; missing: ${missing}. A thin grid can look like "few trips" when it is really "few traps" - each unseeded kind is a class of agent behavior nothing is watching for. Seed the missing kinds before reading the trip count as reassurance.`;
  }

  return { byKind, kindsSeeded, totalKinds: CANARY_KINDS.length, totalActive, gaps, trips: tripCount, assessment };
}
