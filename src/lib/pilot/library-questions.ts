/**
 * Read the library and produce the questions, for the pilot page.
 *
 * Thin on purpose: the judgment lives in library-shape.ts where it can be
 * tested without a database, and this only fetches what that needs.
 */

import { query } from "@/lib/db";
import { PILOT_ESTATE } from "./phase-one";
import { libraryQuestions, type Observation } from "./library-shape";
import { trackEvent } from "@/lib/analytics";

export interface LibraryQuestions {
  questions: Observation[];
  /**
   * False when the library could not be read.
   *
   * A library with nothing odd about it and one we failed to open are the same
   * empty list and opposite facts.
   */
  readable: boolean;
}

export async function readLibraryQuestions(): Promise<LibraryQuestions> {
  try {
    const { rows } = await query<{ filename: string; chunk_count: number | null }>(
      /* Scoped to the client's estate, like every other figure on this page.
         These questions are shown to a client about THEIR library; a filename
         pattern drawn from another client's site would be a question about
         somebody else's documents. */
      `SELECT filename, chunk_count FROM brain_documents
        WHERE status = 'indexed' AND estate = $1`,
      [PILOT_ESTATE],
    );
    const questions = libraryQuestions(
      rows.map((r) => ({ filename: r.filename, chunks: r.chunk_count ?? 0 })),
    );
    /* Recorded so the capability register can tell this ran from this having
       been built. Four capabilities were found dead this way. */
    trackEvent("insights.library_questioned", "system", "system", {
      documents: rows.length,
      questions: questions.length,
    });
    return { questions, readable: true };
  } catch {
    /* silent-ok: readable:false is the signal, and the page renders "could not
       be read" rather than an empty list. */
    return { questions: [], readable: false };
  }
}
