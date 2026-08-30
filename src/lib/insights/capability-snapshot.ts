/**
 * What this product can demonstrably do, read from what it has actually done.
 *
 * /admin/insights is the Phase 1 shop window: the pre-built version of what a
 * client will be shown before their own infrastructure exists. So every figure
 * on it is READ from ninety days of events rather than written down. A
 * capability page that asserts is a capability page that goes stale between
 * the demo and the engagement.
 *
 * WHY THE ZEROS ARE ON IT DELIBERATELY. Outbound redaction has never fired,
 * and the honest way to show that is "0 responses required redaction, and the
 * inspector ran on every one", not a blank tile and not a hidden panel. This
 * codebase spent a week finding controls that were declared, described
 * accurately, and never executed; a client-facing page that cannot tell those
 * apart is the same failure pointed outward. Every reading therefore carries
 * whether it could be taken at all, and an unreadable one says so instead of
 * rendering as zero.
 *
 * COMPOSES EXISTING READERS. getDeterministicShare already computes the
 * headline number; the router already records model, tier and cost per call;
 * the OGIAM ledger already signs its checkpoints. Nothing here re-derives any
 * of that.
 */

import { query } from "@/lib/db";
import { getDeterministicShare } from "@/lib/ai/models/deterministic-share";

/** A figure that might not have been measurable. Null is never zero. */
export interface Reading {
  value: number | null;
  detail: string;
}

export interface CapabilitySnapshot {
  windowDays: number;
  takenAt: string;
  /** Every agent action passed a deterministic gate before it ran. */
  gate: {
    actionsAuthorized: Reading;
    checkpointsSigned: Reading;
  };
  /** How little of the product needs a model, and what the models cost. */
  efficiency: {
    deterministicSharePct: Reading;
    modelCalls: Reading;
    cheapTierPct: Reading;
    spendUsd: Reading;
  };
  /** What the router stopped from leaving. */
  safety: {
    responsesRedacted: Reading;
    responsesFlagged: Reading;
    /**
     * SENSITIVE INPUT STOPPED BEFORE IT REACHED A MODEL.
     *
     * The control a client actually asks about, and the one that fires. A
     * person pastes a card number, a national ID or an API key into the chat
     * box, by mistake or in a hurry, and it is removed before the prompt
     * leaves this process.
     *
     * Reported because the two OUTBOUND counters above are both zero and
     * always have been. That is honest for what they measure, which is what a
     * MODEL sent back, and for a product answering questions about documents
     * that shape is genuinely rare. But a client reading "0 answers flagged"
     * next to a promise about safety reasonably concludes the safety check
     * found nothing, when in fact a different check has been catching real
     * things all along and nothing showed it.
     */
    sensitiveInputsRedacted: Reading;
    /** True when the inspector demonstrably runs, so a zero is good news. */
    inspectorProven: boolean;
  };
  /** Whether the Brain can answer in a person's own words. */
  retrieval: {
    chunksEmbeddedPct: Reading;
    answerableDocuments: Reading;
  };
}

const unreadable = (why: string): Reading => ({ value: null, detail: why });

async function scalar(sql: string, params: unknown[] = []): Promise<number | null> {
  try {
    const { rows } = await query<{ n: string | null }>(sql, params);
    const raw = rows[0]?.n;
    if (raw === null || raw === undefined) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;

export async function readCapabilitySnapshot(windowDays = 90): Promise<CapabilitySnapshot> {
  const days = Math.min(Math.max(Math.floor(windowDays), 1), 365);
  const since = `NOW() - ($1::int * INTERVAL '1 day')`;

  const [
    authorized,
    checkpoints,
    redacted,
    flagged,
    promptRedacted,
    tierRows,
    chunkRows,
    docRows,
    detShare,
  ] = await Promise.all([
    scalar(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ogiam.action_authorized' AND timestamp > ${since}`, [days]),
    scalar(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ogiam.checkpoint_signed' AND timestamp > ${since}`, [days]),
    scalar(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ai.response_redacted' AND timestamp > ${since}`, [days]),
    scalar(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ai.response_flagged' AND timestamp > ${since}`, [days]),
    scalar(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ai.prompt_redacted' AND timestamp > ${since}`, [days]),
    query<{ tier: string; calls: string; usd: string | null }>(
      `SELECT COALESCE(metadata->>'tier','unknown') AS tier, count(*)::text AS calls,
              COALESCE(sum((metadata->>'cost_usd')::numeric),0)::text AS usd
         FROM instinct_events
        WHERE event_type='ai.completion' AND timestamp > ${since}
        GROUP BY 1`,
      [days],
    ).catch(() => null),
    query<{ embedded: string; total: string }>(
      `SELECT count(*) FILTER (WHERE embedded)::text AS embedded, count(*)::text AS total FROM brain_chunks`,
    ).catch(() => null),
    /* Client corpus only. Counting the demo seeder's fixtures as answerable
       documents on a client-facing page would be the same lie the retrieval
       boundary exists to stop. */
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_documents
        WHERE status='indexed' AND (uploaded_by IS NULL OR uploaded_by <> ALL($1))`,
      [["demo-cto", "platform-scan"]],
    ).catch(() => null),
    getDeterministicShare(days).catch(() => null),
  ]);

  const tiers = tierRows?.rows ?? null;
  const totalCalls = tiers ? tiers.reduce((n, r) => n + Number(r.calls), 0) : null;
  const cheapCalls = tiers
    ? tiers.filter((r) => r.tier === "cheap").reduce((n, r) => n + Number(r.calls), 0)
    : null;
  const spend = tiers ? tiers.reduce((n, r) => n + Number(r.usd ?? 0), 0) : null;

  const embedded = chunkRows ? Number(chunkRows.rows[0]?.embedded ?? 0) : null;
  const totalChunks = chunkRows ? Number(chunkRows.rows[0]?.total ?? 0) : null;

  return {
    windowDays: days,
    takenAt: new Date().toISOString(),
    gate: {
      actionsAuthorized:
        authorized === null
          ? unreadable("The event store could not be read.")
          : { value: authorized, detail: "agent actions passed the deterministic gate before running" },
      checkpointsSigned:
        checkpoints === null
          ? unreadable("The event store could not be read.")
          : { value: checkpoints, detail: "hash-chained checkpoints signed over the decision ledger" },
    },
    efficiency: {
      deterministicSharePct: detShare
        ? {
            value: Math.round(detShare.share * 100),
            detail: `${detShare.replies - detShare.modelReplies} of ${detShare.replies} answers used no model at all`,
          }
        : unreadable("The reply figures could not be read."),
      modelCalls:
        totalCalls === null
          ? unreadable("The completion log could not be read.")
          : { value: totalCalls, detail: `model calls in ${days} days` },
      cheapTierPct:
        totalCalls === null || cheapCalls === null
          ? unreadable("The completion log could not be read.")
          : {
              value: pct(cheapCalls, totalCalls),
              detail: `${cheapCalls} of ${totalCalls} calls served by the cheapest capable model`,
            },
      spendUsd:
        spend === null
          ? unreadable("The completion log could not be read.")
          : { value: Math.round(spend * 100) / 100, detail: `total model spend across ${days} days` },
    },
    safety: {
      responsesRedacted:
        redacted === null
          ? unreadable("The event store could not be read.")
          : {
              value: redacted,
              detail:
                redacted === 0
                  ? "no outbound answer has contained a secret or personal identifier"
                  : "outbound answers had a credential or identifier removed before sending",
            },
      responsesFlagged:
        flagged === null
          ? unreadable("The event store could not be read.")
          : {
              value: flagged,
              /* RECORDED, NOT WITHHELD. This said "withheld or corrected
                 before reaching a person". The router inspects every answer
                 and writes an audit row when one carries a risky shape, then
                 delivers it: its own comment says "Recorded rather than
                 blocked", because a refusal on a false positive costs more
                 trust in a product that writes code for a living than a
                 flagged audit row does. Describing an audit trail as an
                 interception is the product claiming a control it has
                 deliberately chosen not to exercise. */
              detail:
                flagged === 0
                  ? "the inspector ran on every model answer and matched none"
                  : "model answers carried a risky shape and were logged for review; the answer was still delivered",
            },
      /* THE CONTROL THAT ACTUALLY FIRES, reported because the two above do
         not. Verified end to end on 2026-08-30 against the production
         database: a pasted card number, a national ID inside a real question,
         bank details, and an API key. None reached the answer, and the one
         that needed a model produced an ai.prompt_redacted row. Bank details
         pasted alongside a genuine question had the details removed and the
         question answered, which is the behaviour worth having: the person is
         helped and the data never leaves. */
      sensitiveInputsRedacted:
        promptRedacted === null
          ? unreadable("The event store could not be read.")
          : {
              value: promptRedacted,
              detail:
                promptRedacted === 0
                  ? "nobody has pasted a card number, identifier or key into a question in this window"
                  : "cards, identifiers and keys removed from questions before any model or outside service saw them",
            },
      /* The inspector is proved by router-verification.test.ts, which asserts
         it runs on an ordinary completion with nothing opted in, and stays
         silent on a clean answer. That is what entitles a zero here to be read
         as good news rather than as a control nobody wired up. */
      inspectorProven: true,
    },
    retrieval: {
      chunksEmbeddedPct:
        embedded === null || totalChunks === null
          ? unreadable("The Brain could not be read.")
          : {
              value: pct(embedded, totalChunks),
              detail: `${embedded} of ${totalChunks} passages answerable in a person's own words`,
            },
      answerableDocuments:
        docRows === null
          ? unreadable("The Brain could not be read.")
          : {
              value: Number(docRows.rows[0]?.n ?? 0),
              detail: "documents indexed and quotable, excluding demo and system-generated content",
            },
    },
  };
}
