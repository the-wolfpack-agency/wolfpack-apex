/**
 * Which weights answered, and the moment that changed.
 *
 * A MODEL ID IS NOT A VERSION
 *
 * Every gate in this system keys on a registry id: residency, retention, the
 * promotion gate, the cost table. All of them are reasoning about a NAME, and
 * the thing behind the name moves. "gpt-4o" has meant several different sets of
 * weights. A model quarantined for regressing is quarantined by name, and the
 * replacement weights that shipped last week inherit that judgment whether or
 * not they deserve it.
 *
 * Providers already tell us. The completion response carries the model that
 * actually served, usually more specific than what was asked for: request
 * gpt-4o, get gpt-4o-2024-11-20. Nothing was reading it, so a silent weights
 * change was invisible until somebody noticed the answers had got worse, at
 * which point the useful question ("what changed, and when") had no answer.
 *
 * WHAT THIS IS NOT
 *
 * Not an alarm. A new version is not a problem, it is an EVENT: the thing that
 * makes a later regression explainable, and the thing that decides whether a
 * quarantine still applies. Treating every version bump as an incident would
 * train everybody to ignore it, which is how the signal dies.
 */

export type DriftKind =
  /** Same version as last time. The overwhelming majority of calls. */
  | "unchanged"
  /** Never seen this model serve anything before. Not a change: a beginning. */
  | "first_sighting"
  /** A different version from the one that was serving. THE event. */
  | "changed"
  /** A version we have seen before is serving again, after another took over.
   *  Usually a provider rolling back, which is worth telling apart from a new
   *  version: it means the previous regression may already be fixed. */
  | "reverted";

export interface KnownVersion {
  servedVersion: string;
  /** ISO timestamp. */
  lastSeenAt: string;
  callCount: number;
}

export interface DriftObservation {
  kind: DriftKind;
  modelId: string;
  servedVersion: string;
  /** What was serving before, when anything was. */
  previousVersion: string | null;
  /** How many calls the previous version took before this one appeared. Small
   *  numbers mean a brief experiment; large ones mean the thing everybody's
   *  work was built on has moved. */
  previousCallCount: number | null;
}

/**
 * Normalize what a provider called itself.
 *
 * Trimmed and lowercased only. NOT stripped of date suffixes, which was the
 * tempting simplification: treating gpt-4o-2024-11-20 as "gpt-4o" would make
 * the whole module blind to the exact change it exists to catch.
 */
export function normalizeVersion(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Compare what just served against what is known.
 *
 * Pure. `known` is every version recorded for this model id, most recently
 * seen first.
 */
export function observeVersion(input: {
  modelId: string;
  servedVersion: string;
  known: readonly KnownVersion[];
}): DriftObservation {
  const served = normalizeVersion(input.servedVersion);
  const known = input.known;
  const current = known[0] ?? null;

  const base = {
    modelId: input.modelId,
    servedVersion: served,
    previousVersion: current ? normalizeVersion(current.servedVersion) : null,
    previousCallCount: current ? current.callCount : null,
  };

  if (!current) return { ...base, kind: "first_sighting", previousVersion: null, previousCallCount: null };
  if (normalizeVersion(current.servedVersion) === served) return { ...base, kind: "unchanged" };

  /* Seen before, and something else has served since. A provider rolling back
     is materially different news from a provider shipping something new: it
     often means a regression somebody else already noticed has been undone. */
  const seenBefore = known.some((k) => normalizeVersion(k.servedVersion) === served);
  return { ...base, kind: seenBefore ? "reverted" : "changed" };
}

/** Did this observation move the ground under the caller? */
export function isMaterial(observation: DriftObservation): boolean {
  return observation.kind === "changed" || observation.kind === "reverted";
}

/**
 * Whether a quarantine recorded against a model id still applies.
 *
 * THE REASON THIS MODULE MATTERS TO THE GATE. A model quarantined for
 * regressing was quarantined for what its weights did. When the provider ships
 * different weights, that judgment is about something that is no longer
 * running, and continuing to refuse is punishing a name.
 *
 * It does not auto-clear the quarantine, because a state that lifts itself is
 * the failure the promotion gate was written to avoid. It reports that the
 * judgment is STALE, which is a prompt for a decision rather than a decision.
 */
export function quarantineIsStale(input: {
  quarantinedVersion: string | null;
  servingVersion: string;
}): boolean {
  if (!input.quarantinedVersion) return false;
  return normalizeVersion(input.quarantinedVersion) !== normalizeVersion(input.servingVersion);
}
