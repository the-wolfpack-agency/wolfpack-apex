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
  /* ALL THREE AT ONCE.
   *
   * These ran in sequence, and this function renders on every request to
   * /playbook. Sequential awaits against a hosted Postgres made the page take
   * nine seconds to navigate to, against a tenth of a second for every other
   * page in the product. The left-nav link gives no loading feedback, so nine
   * seconds of silence was reported, correctly, as a button that does nothing.
   *
   * Independent readings, so the slowest one sets the latency rather than the
   * sum. Each still contains its own failure: one unreadable source degrades
   * that line and leaves the others alone. */
  const [routing, evidence, snapshot] = await Promise.all([
    auditRouting().catch((err) => ({ __error: (err as Error).message }) as const),
    gatherEvidence(90).catch(() => null),
    getPhaseOneSnapshot(workspaceId).catch(() => null),
  ]);

  const lines: ReadingLine[] = [];

  /* ROUTING. Pure functions over strings, so this one can almost always be
     taken. */
  if (routing && !("__error" in routing)) {
    const pct = routing.total > 0 ? Math.round((routing.reachedOne / routing.total) * 100) : null;
    lines.push({
      label: "Ordinary questions routed to a built answer",
      value: pct === null ? null : `${pct}%`,
      detail:
        pct === null
          ? "The corpus was empty, so there is nothing to report."
          : `${routing.reachedOne} of ${routing.total} prompts a person would plainly type reach exactly one tool. The rest fall through to a model.`,
    });
  } else {
    lines.push(
      UNKNOWN(
        "Ordinary questions routed to a built answer",
        `Not measurable: ${routing && "__error" in routing ? routing.__error : "unknown"}`,
      ),
    );
  }

  /* INTEGRATIONS. Built is not the same as run, and the difference is the
     number a client should be given. */
  if (evidence) {
    const run = evidence.filter((e) => verdict(e) !== "unproven").length;
    lines.push({
      label: "Integrations that have run in production",
      value: `${run} of ${evidence.length}`,
      detail:
        "Counted from ninety days of events, not from the registry. The remainder are built and have never been exercised, which is a different claim.",
    });
  } else {
    lines.push(
      UNKNOWN(
        "Integrations that have run in production",
        "The event store could not be read, so this is unmeasured rather than zero.",
      ),
    );
  }

  /* DETERMINISTIC SHARE. The number the product is sold on. */
  if (snapshot?.readable) {
    const share = deterministicShare(snapshot);
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
      value: snapshot.passages.toLocaleString("en-US"),
      detail: `Across ${snapshot.libraries} connected ${snapshot.libraries === 1 ? "library" : "libraries"}.`,
    });
  } else {
    lines.push(UNKNOWN("Answers given without a model", "The figures could not be read."));
  }

  return { takenAt: new Date().toISOString(), lines };
}
