/**
 * What the document pipeline is quietly failing to do.
 *
 * EVERY CHECK HERE IS SOMETHING THAT WENT WRONG AND WAS FOUND BY HAND. Ten
 * PDFs sat mid-ingest from 2026-05-16 to 2026-08-27 because nothing was
 * looking. Ninety Word documents failed on a parser bug that was fixed in
 * August while the rows stayed broken. A sync reported hundreds of successes
 * per pass while its remaining count went UP. Seven hundred and forty four of
 * the 795 answerable documents turned out to be demo fixtures and scanner
 * output.
 *
 * Not one of those was caught by a test. Each was found because somebody
 * eventually asked the right question of the database, which is the definition
 * of work an agent should be doing on a schedule.
 *
 * PURE READS. Nothing here writes, so it is safe to run often and safe to hand
 * to an agent whose writes are gated. It returns findings; deciding what to do
 * about them is somebody else's job.
 */

import { query } from "@/lib/db";
import { NON_CORPUS_UPLOADER_IDS } from "./corpus";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** What is true, in numbers. */
  detail: string;
  /** What to do about it. Absent when there is nothing to do yet. */
  action?: string;
  count: number;
}

export interface IngestionHealth {
  takenAt: string;
  /** False when the database could not be read. Findings are then empty, and
   *  an empty list must never be reported as a clean bill of health. */
  readable: boolean;
  findings: Finding[];
}

/** How long a document may sit mid-ingest before it is abandoned rather than busy. */
const STRANDED_MINUTES = 60;

export async function readIngestionHealth(): Promise<IngestionHealth> {
  const takenAt = new Date().toISOString();
  try {
    const { rows } = await query<{
      stranded: string;
      stranded_oldest_days: string | null;
      failed: string;
      skipped: string;
      indexed_no_chunks: string;
      unembedded: string;
      non_corpus: string;
      client_corpus: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('queued','extracting','chunking','embedding')
                            AND updated_at < NOW() - ($1::int * INTERVAL '1 minute'))::text AS stranded,
         EXTRACT(DAY FROM NOW() - min(updated_at) FILTER (WHERE status IN ('queued','extracting','chunking','embedding')
                            AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')))::text AS stranded_oldest_days,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'skipped')::text AS skipped,
         count(*) FILTER (WHERE status = 'indexed' AND chunk_count = 0)::text AS indexed_no_chunks,
         0::text AS unembedded,
         count(*) FILTER (WHERE status = 'indexed' AND uploaded_by = ANY($2))::text AS non_corpus,
         count(*) FILTER (WHERE status = 'indexed' AND (uploaded_by IS NULL OR uploaded_by <> ALL($2)))::text AS client_corpus
       FROM brain_documents`,
      [STRANDED_MINUTES, NON_CORPUS_UPLOADER_IDS],
    );
    const r = rows[0];
    const n = (v: string | null | undefined) => Number(v ?? 0);

    const { rows: chunkRows } = await query<{ unembedded: string }>(
      `SELECT count(*) FILTER (WHERE NOT embedded)::text AS unembedded FROM brain_chunks`,
    );

    const findings: Finding[] = [];

    const stranded = n(r?.stranded);
    if (stranded > 0) {
      const days = n(r?.stranded_oldest_days);
      findings.push({
        id: "stranded",
        severity: days > 1 ? "high" : "medium",
        title: `${stranded} document${stranded === 1 ? "" : "s"} stuck mid-ingest`,
        detail:
          days > 0
            ? `Oldest has been mid-ingest for ${days} day${days === 1 ? "" : "s"}. Nothing will move it on its own.`
            : `Stuck for over an hour. Nothing will move them on their own.`,
        action: "Re-run the source sync, or clear the stuck job on the connectors page.",
        count: stranded,
      });
    }

    const noChunks = n(r?.indexed_no_chunks);
    if (noChunks > 0) {
      findings.push({
        id: "indexed_no_chunks",
        severity: "high",
        /* The worst kind: it reads as done and answers nothing. */
        title: `${noChunks} document${noChunks === 1 ? "" : "s"} indexed with nothing in them`,
        detail:
          "Status says indexed, chunk count is zero, so they are counted as answerable and can never be quoted.",
        action: "Re-extract these; an indexed document with no chunks is a silent hole in the corpus.",
        count: noChunks,
      });
    }

    const unembedded = n(chunkRows[0]?.unembedded);
    if (unembedded > 0) {
      findings.push({
        id: "unembedded",
        severity: "medium",
        title: `${unembedded} passage${unembedded === 1 ? "" : "s"} not embedded`,
        detail:
          "Answerable by keyword only. A question phrased in somebody's own words will miss them.",
        action: "npm run brain-backfill",
        count: unembedded,
      });
    }

    const failed = n(r?.failed);
    if (failed > 0) {
      findings.push({
        id: "failed",
        severity: "medium",
        title: `${failed} document${failed === 1 ? "" : "s"} failed to extract`,
        detail: "In the library and not answerable. Some are fixable parser bugs, some are genuinely scanned.",
        action: "GET /api/admin/brain/reprocess to see which are worth retrying.",
        count: failed,
      });
    }

    const skipped = n(r?.skipped);
    if (skipped > 0) {
      findings.push({
        id: "skipped",
        severity: "low",
        title: `${skipped} document${skipped === 1 ? "" : "s"} skipped for want of an extractor`,
        detail: "Mostly decks, images and archives. Each is a format nobody can ask about yet.",
        count: skipped,
      });
    }

    const nonCorpus = n(r?.non_corpus);
    const clientCorpus = n(r?.client_corpus);
    const total = nonCorpus + clientCorpus;
    if (nonCorpus > 0 && total > 0) {
      const share = Math.round((nonCorpus / total) * 100);
      findings.push({
        id: "non_corpus_share",
        severity: share > 50 ? "high" : "low",
        title: `${share}% of answerable documents are demo or system-generated`,
        detail: `${clientCorpus} of ${total} are real content. The rest are excluded from retrieval but still counted in the library.`,
        action:
          share > 50
            ? "Sync the real libraries; the corpus is mostly not the client's own material."
            : undefined,
        count: nonCorpus,
      });
    }

    return { takenAt, readable: true, findings };
  } catch {
    /* An empty findings list from an unreadable database must never be
       reported as a clean pipeline. That is the mistake this whole file
       exists to catch, and it would be embarrassing to make it here. */
    return { takenAt, readable: false, findings: [] };
  }
}

/** One line an agent or a page can lead with. */
export function summarizeHealth(h: IngestionHealth): string {
  if (!h.readable) {
    return "The document pipeline could not be read, so its health is unknown. That is not the same as healthy.";
  }
  if (h.findings.length === 0) {
    return "Nothing to flag. Every document is either answerable or explicitly accounted for.";
  }
  const high = h.findings.filter((f) => f.severity === "high").length;
  return high > 0
    ? `${h.findings.length} thing${h.findings.length === 1 ? "" : "s"} to look at, ${high} of them serious.`
    : `${h.findings.length} thing${h.findings.length === 1 ? "" : "s"} to look at, none serious.`;
}
