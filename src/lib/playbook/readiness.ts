/**
 * The measured state of the product, for the client-facing document.
 *
 * WHY THIS EXISTS. /playbook is what we hand a client, and until now every
 * number in it was a sentence somebody typed. The handoff of 2026-08-26 lists
 * three separate cases where a typed number had drifted from the product:
 * "eighteen integrations" when twelve had ever run, "a second model reviews
 * every answer" when it had reviewed none in ninety days, and a post-quantum
 * claim for something not built. A document that asserts goes stale silently;
 * a document that READS cannot.
 *
 * EVERY FIELD CAN BE UNKNOWN. Each reading is independent and carries whether
 * it could be taken, because a client-facing page is the very last place a
 * zero should be allowed to stand in for "we could not measure it".
 */

import { auditRouting } from "@/lib/assistant/routing-audit";
import { gatherEvidence, verdict } from "@/lib/integrations/evidence";
import { getPhaseOneSnapshot } from "@/lib/pilot/phase-one";
import { deterministicShare } from "@/lib/pilot/phase-one-shape";

export interface ReadingLine {
  label: string;
  /** Null when it could not be measured. NEVER coerced to a number. */
  value: string | null;
  detail: string;
}

export interface PlaybookReadiness {
  takenAt: string;
  lines: ReadingLine[];
}

/** A reading that could not be taken says so, in the slot a reader scans. */
const UNKNOWN = (label: string, why: string): ReadingLine => ({
  label,
  value: null,
  detail: why,
});

export async function readPlaybookReadiness(
  workspaceId = "default",
): Promise<PlaybookReadiness> {
  const lines: ReadingLine[] = [];

  /* ROUTING. Pure functions over strings, so this one can always be taken. */
  try {
    const r = await auditRouting();
    const pct = r.total > 0 ? Math.round((r.reachedOne / r.total) * 100) : null;
    lines.push({
      label: "Ordinary questions routed to a built answer",
      value: pct === null ? null : `${pct}%`,
      detail:
        pct === null
          ? "The corpus was empty, so there is nothing to report."
          : `${r.reachedOne} of ${r.total} prompts a person would plainly type reach exactly one tool. The rest fall through to a model.`,
    });
  } catch (err) {
    lines.push(
      UNKNOWN(
        "Ordinary questions routed to a built answer",
        `Not measurable: ${(err as Error).message}`,
      ),
    );
  }

  /* INTEGRATIONS. Built is not the same as run, and the difference is the
     number a client should be given. */
  try {
    const ev = await gatherEvidence(90);
    const run = ev.filter((e) => verdict(e) !== "unproven").length;
    lines.push({
      label: "Integrations that have run in production",
      value: `${run} of ${ev.length}`,
      detail:
        "Counted from ninety days of events, not from the registry. The remainder are built and have never been exercised, which is a different claim.",
    });
  } catch {
    lines.push(
      UNKNOWN(
        "Integrations that have run in production",
        "The event store could not be read, so this is unmeasured rather than zero.",
      ),
    );
  }

  /* DETERMINISTIC SHARE. The number the product is sold on. */
  try {
    const snap = await getPhaseOneSnapshot(workspaceId);
    if (!snap.readable) {
      lines.push(UNKNOWN("Answers given without a model", "The figures could not be read."));
    } else {
      const share = deterministicShare(snap);
      lines.push({
        label: "Answers given without a model",
        value: share === null ? null : `${Math.round(share * 100)}%`,
        detail:
          share === null
            ? "Nothing has been asked yet, so a share would be a division by zero rather than a zero."
            : "Answered directly from connected systems. No tokens, and no opportunity to invent.",
      });
      lines.push({
        label: "Passages indexed and answerable",
        value: snap.passages.toLocaleString("en-US"),
        detail: `Across ${snap.libraries} connected ${snap.libraries === 1 ? "library" : "libraries"}.`,
      });
    }
  } catch {
    lines.push(UNKNOWN("Answers given without a model", "The figures could not be read."));
  }

  return { takenAt: new Date().toISOString(), lines };
}
