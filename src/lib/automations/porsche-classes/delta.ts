/**
 * porsche-classes / delta — pure diff between two snapshots.
 *
 * No I/O. Given a previous + current participant list, returns the
 * `added` / `dropped` / `net_change` shape the persistence layer
 * inserts as a `_deltas` row.
 *
 * Both inputs are assumed to already be `canonicalParticipants` form
 * (lowercased, deduped, sorted). The wrapper at the call site —
 * `ingest.ts` — guarantees that.
 *
 * Cases handled:
 *   1. baseline    — prev null    → added = curr, dropped = []
 *   2. added-only  — additions only
 *   3. dropped-only— removals only
 *   4. mixed       — both
 */

export interface DeltaShape {
  added: string[];
  dropped: string[];
  net_change: number;
  is_baseline: boolean;
}

export function computeDelta(
  prev: ReadonlyArray<string> | null,
  curr: ReadonlyArray<string>,
): DeltaShape {
  if (prev === null) {
    // First-ever observation for this class_key — record everyone in
    // `added` for the audit trail and mark the row baseline so the
    // changes UI can render it differently ("first seen" vs. "joined").
    const added = [...curr].sort();
    return {
      added,
      dropped: [],
      net_change: added.length,
      is_baseline: true,
    };
  }

  const prevSet = new Set(prev);
  const currSet = new Set(curr);

  const added: string[] = [];
  for (const p of curr) {
    if (!prevSet.has(p)) added.push(p);
  }
  const dropped: string[] = [];
  for (const p of prev) {
    if (!currSet.has(p)) dropped.push(p);
  }

  added.sort();
  dropped.sort();

  return {
    added,
    dropped,
    net_change: added.length - dropped.length,
    is_baseline: false,
  };
}
