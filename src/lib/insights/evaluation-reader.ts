/**
 * Turn the evaluation exports into records the scan can read.
 *
 * WHY IT COUNTS WHAT IT MISSES. The exports are spreadsheets flattened into
 * text and then chunked for retrieval, so a record can be cut in half by a
 * chunk boundary. That is a real limit and the honest response is to report it
 * rather than to present a slightly-short total as the total. A scan whose
 * whole argument is that figures should carry their evidence cannot round its
 * own down in silence.
 *
 * NAMES ARE NEVER CARRIED OUT. Every row holds a first name, a last name and a
 * staff id. None of that reaches a DatasetRecord: the dimensions worth cutting
 * by are role, month and venue, and the identity adds nothing to any of them.
 */

import { query } from "@/lib/db";
import type { DatasetRecord } from "./dataset-scan";

/** The role column, as the exports write it. */
const ROLE = /PCNA,(PCNA [A-Za-z ]+?),,/g;
/** Submission timestamps, which is where the period comes from. */
const DATE = /,(\d{1,2})\/\d{1,2}\/(\d{4}) \d{1,2}:/g;
/** Venues, which only some exports record at all. */
const VENUE = /"?,(Ritz Carlton|Conrad|Westlake|Intercontinental|Pendry|Las Colinas)[",]/g;
/** The instrument: the questions the evaluation actually asks. */
const PROMPT = /"(How [^"]{20,120}?)[?"]/g;

export interface EvaluationCorpus {
  records: DatasetRecord[];
  documents: number;
  /**
   * Records whose fields were split across a chunk boundary.
   *
   * Reported so a total can be read as "at least this many" rather than
   * "exactly this many", which is the difference between a figure and a guess.
   */
  partial: number;
}

export async function readEvaluations(like = "Survey Data%"): Promise<EvaluationCorpus> {
  const { rows } = await query<{ filename: string; content: string }>(
    `SELECT d.filename, c.content
       FROM brain_chunks c
       JOIN brain_documents d ON d.id = c.document_id
      WHERE d.filename ILIKE $1 AND d.status = 'indexed'
      ORDER BY d.filename, c.chunk_idx`,
    [like],
  );

  const records: DatasetRecord[] = [];
  let partial = 0;

  for (const row of rows) {
    const roles = [...row.content.matchAll(ROLE)].map((m) => m[1]);
    const dates = [...row.content.matchAll(DATE)].map((m) => `${m[2]}-${m[1].padStart(2, "0")}`);
    const venues = [...row.content.matchAll(VENUE)].map((m) => m[1]);
    const prompts = [...row.content.matchAll(PROMPT)].map((m) => m[1].trim().slice(0, 70));

    /* ONE RECORD PER ROLE, AND A FIELD ONLY WHEN IT LINES UP.
     *
     * The role column appears exactly once per response and is the only field
     * on every export, so it sets the record count. The other columns are
     * matched by position, which is only sound when the chunk yielded the same
     * number of each: a chunk cut mid-row leaves four roles and three dates,
     * and pairing them anyway shifts every date onto the wrong person.
     *
     * So a mismatch drops the field rather than guessing at it, and the drop
     * is counted. That is why venue coverage reads 26 per cent instead of
     * something flattering: the other 74 per cent could not be attributed, and
     * a scan built to show its evidence does not get to hide its own. */
    const dateAligned = dates.length === roles.length;
    const venueAligned = venues.length === roles.length;
    const promptAligned = prompts.length === roles.length;

    for (let i = 0; i < roles.length; i++) {
      if (!dateAligned || !venueAligned || !promptAligned) partial += 1;
      records.push({
        role: roles[i],
        ...(dateAligned ? { month: dates[i] } : {}),
        ...(venueAligned ? { venue: venues[i] } : {}),
        ...(promptAligned ? { prompt: prompts[i] } : {}),
        answerChars: 0,
      });
    }
  }

  return { records, documents: new Set(rows.map((r) => r.filename)).size, partial };
}
