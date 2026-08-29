/**
 * Mine candidate eval pairs from what people actually asked.
 *
 * WHY HARVEST RATHER THAN WRITE
 *
 * The eval set was six hand-written pairs, which is too few to decide anything:
 * one question moving is 17% of the set, so the reciprocal-rank result
 * (MRR 0.557 -> 0.700) is directionally right and weakly evidenced. Production
 * already holds 399 questions where an answer cited a document, which is 399
 * candidate pairs nobody has to invent.
 *
 * THE TRAP, AND WHY THESE ARE CANDIDATES AND NOT GROUND TRUTH
 *
 * `cited` means the system USED that document, not that it was the right one.
 * "How much do we owe upfront?" cited a chauffeur invoice: a plausible answer
 * from the wrong file. An eval built uncritically from our own outputs measures
 * CONSISTENCY, not correctness, and would happily score a regression toward the
 * status quo as a pass. It would also be blind to precisely the failures worth
 * catching, because those are the ones the current system already gets wrong.
 *
 * So this emits candidates with `reviewed: false`. A pair earns its place by
 * somebody reading it, which is cheap per pair and is the only step that turns
 * usage into ground truth. The eval runner is free to weight or skip unreviewed
 * pairs; what it must not do is pretend they are labelled.
 *
 * Usage:
 *   npx tsx scripts/harvest-eval-pairs.ts > candidates.json
 *   # read them, delete the wrong ones, set reviewed: true on the rest
 */
import { query } from "@/lib/db";

interface Candidate {
  question: string;
  expectFilename: string;
  /** How many times this question cited this document. */
  timesCited: number;
  /** Always false here. Ground truth requires a human, by construction. */
  reviewed: boolean;
}

async function main(): Promise<void> {
  const { rows } = await query<{
    question: string;
    filename: string;
    times: string;
  }>(
    `SELECT q.query AS question,
            d.filename,
            count(*)::text AS times
       FROM brain_query_log q
       JOIN brain_chunks c ON c.id = q.hit_chunk_ids[1]
       JOIN brain_documents d ON d.id = c.document_id
      WHERE q.cited
        /* Long enough to be a question rather than an acknowledgement. "yes"
           and "ok" cite whatever the previous turn used and label nothing. */
        AND length(btrim(q.query)) > 12
        AND d.status = 'indexed'
      GROUP BY q.query, d.filename
      /* Asked more than once: a one-off is as likely to be somebody probing as
         a question worth grading, and repetition is the cheapest signal that
         it matters to somebody. */
     HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 200`,
  );

  /* One document per question. A question that cited two different files is
     ambiguous evidence, and an eval pair has to have one right answer. */
  const best = new Map<string, Candidate>();
  for (const r of rows) {
    const times = Number(r.times);
    const existing = best.get(r.question);
    if (!existing || times > existing.timesCited) {
      best.set(r.question, {
        question: r.question,
        /* The distinctive part of the name, so a re-sync that changes a
           timestamp does not break the pair. */
        expectFilename: r.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 40),
        timesCited: times,
        reviewed: false,
      });
    }
  }

  const candidates = [...best.values()].sort((a, b) => b.timesCited - a.timesCited);
  console.log(JSON.stringify(candidates, null, 2));
  console.error(
    `\n${candidates.length} candidates from ${rows.length} question/document pairs.\n` +
      `NONE of these is ground truth yet: citation means the system used a document,\n` +
      `not that it was the right one. Read them, delete the wrong ones, and set\n` +
      `reviewed: true on what survives.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
