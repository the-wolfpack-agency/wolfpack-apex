/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Build eval pairs from the documents, instead of guessing them from clicks.
 *
 * WHY THE OLD WAY WAS ABANDONED. The harvester read the query log and paired a
 * question with whichever document got cited near it. Citation is a real
 * signal and not a sufficient one: somebody having a file open is not the same
 * as that file answering the question. On this corpus it produced a test
 * Salesforce account as its top candidate, twice as many citations as anything
 * else, plus two screenshots against calendar questions and a video playlist
 * against "whats in sharepoint". Five of six candidates were unusable and the
 * sixth was a maybe.
 *
 * Worse than useless, actually. Its most-cited pair was the question "Meeting
 * Notes with McDonalds" expecting the file "Meeting Notes with McDonalds",
 * which retrieval cannot fail. Grading against it would have raised recall
 * while changing nothing about the product.
 *
 * SO THE GROUND TRUTH COMES FROM THE OTHER DIRECTION. Take a passage, ask what
 * question it answers, and the correct document is known by construction
 * because we chose the passage. There is no inference and nothing to be wrong
 * about. This is the standard way test sets are built for retrieval, and the
 * reason a public benchmark does not help here: BEIR and MS MARCO score
 * retrieval over their own corpora, and how well we find a Wikipedia paragraph
 * says nothing about whether we find a client's work order.
 *
 * IT DELIBERATELY DOES NOT CHECK ITS OWN ANSWERS BY RETRIEVING THEM. Keeping
 * only the pairs the product already finds would make the eval agree with the
 * product by construction, and the number would rise every time retrieval got
 * narrower. A test set has to be able to fail.
 *
 * Usage:
 *   npx tsx scripts/generate-eval-pairs.ts               # 40 candidates
 *   npx tsx scripts/generate-eval-pairs.ts --count 80
 *
 * Writes candidates for review. Nothing enters the graded set without a human.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { query } from "@/lib/db";
import { getAIClient } from "@/lib/ai/router";
import { namesTheFile, familyStem, collidingPairs } from "@/lib/brain/eval/pair-quality";

const CANDIDATES_PATH = "src/lib/brain/eval/retrieval-candidates.json";
const PAIRS_PATH = "src/lib/brain/eval/retrieval-pairs.json";

/**
 * Documents worth asking a question about.
 *
 * NOT A TASTE JUDGMENT: a receipt genuinely has no question a colleague would
 * ask of it beyond its own total, and pairs built from one measure whether we
 * can find a number that appears nowhere else, which every retriever can do.
 * 148 of 884 indexed documents are receipts, invoices, screenshots, flight
 * bookings or video, and they are excluded by name rather than by guessing.
 */
const NOT_A_SUBJECT =
  /(receipt|invoice|screenshot|flight|rideshare|\.mp4|shipping log|\.pla|^_?WITH_relevant|SELECT_s_)/i;

/** Below this a document has no passage long enough to ask about. */
const MIN_CHUNKS = 5;


/** Enough text to carry a real answer. */
const MIN_CHUNK_CHARS = 600;

const SYSTEM = [
  "You write evaluation questions for a document search system.",
  "Given a passage, write ONE question that this passage answers.",
  "",
  "Rules:",
  "- Write it the way a colleague would ask, in plain words.",
  "- NEVER name the file, the document title, or quote a phrase only that file uses.",
  "  A question that restates its own filename cannot be got wrong and is useless.",
  "- Ask about something specific in the passage, not about the topic in general.",
  "- If the passage is boilerplate, a header, a table of contents or a legal notice,",
  "  reply with exactly: SKIP",
  "",
  'Reply as JSON only: {"question": "...", "answer": "one sentence from the passage"}',
].join("\n");

interface Candidate {
  question: string;
  expectFilename: string;
  reviewed: false;
  source: "generated";
  /** So a reviewer can judge in seconds instead of opening the document. */
  passage: string;
  answer: string;
}




async function main(): Promise<void> {
  const countArg = process.argv.indexOf("--count");
  const want = countArg > -1 ? Number(process.argv[countArg + 1]) : 40;

  const existing: { question: string }[] = existsSync(PAIRS_PATH)
    ? JSON.parse(readFileSync(PAIRS_PATH, "utf8"))
    : [];
  const alreadyAsked = new Set(existing.map((p) => p.question.trim().toLowerCase()));

  /* One passage per document, the longest one, so no single file can dominate
     the set and a good score cannot come from finding one document often. */
  const { rows } = await query<{ filename: string; content: string }>(
    `SELECT DISTINCT ON (d.id) d.filename, c.content
       FROM brain_documents d
       JOIN brain_chunks c ON c.document_id = d.id
      WHERE d.status = 'indexed'
        AND coalesce(d.chunk_count, 0) >= $1
        AND length(c.content) >= $2
      ORDER BY d.id, length(c.content) DESC`,
    [MIN_CHUNKS, MIN_CHUNK_CHARS],
  );

  const named = rows.filter((r) => !NOT_A_SUBJECT.test(r.filename));

  /* Drop every member of a family rather than picking one, because picking one
     would still let the eval mark a correct sibling wrong. */
  const familySize = new Map<string, number>();
  for (const r of named) {
    const stem = familyStem(r.filename);
    familySize.set(stem, (familySize.get(stem) ?? 0) + 1);
  }
  const eligible = named.filter((r) => (familySize.get(familyStem(r.filename)) ?? 0) === 1);

  console.log(
    `${eligible.length} documents worth asking about.\n` +
      `  ${rows.length - named.length} excluded as receipts, screenshots, video or data dumps\n` +
      `  ${named.length - eligible.length} excluded as one of several near-identical siblings,\n` +
      `    where any of them answers the question and naming one would mark a tie as a miss\n`,
  );

  const client = getAIClient();
  const out: Candidate[] = [];
  let skipped = 0;
  let selfAnswering = 0;

  for (const doc of eligible.slice(0, want)) {
    const passage = doc.content.slice(0, 3000);
    let raw = "";
    try {
      const res = await client.complete({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: passage },
        ],
        max_tokens: 200,
        model_tier: "cheap",
        metadata: { feature: "brain.eval_pair_generation", user_id: "eval-builder", user_role: "cto" },
      });
      raw = res.content.trim();
    } catch {
      /* silent-ok: one document failing to produce a question costs the set one
         pair. Failing the whole run over it would cost every pair. */
      continue;
    }

    if (/^SKIP\b/i.test(raw)) {
      skipped++;
      continue;
    }

    let parsed: { question?: string; answer?: string };
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      skipped++;
      continue;
    }

    const question = (parsed.question ?? "").trim();
    if (question.length < 12) {
      skipped++;
      continue;
    }
    if (alreadyAsked.has(question.toLowerCase())) continue;

    /* THE FAILURE THIS WHOLE FILE EXISTS TO AVOID. Rejected here rather than
       left for a reviewer, because it is the one a reviewer waves through. */
    if (namesTheFile(question, doc.filename)) {
      selfAnswering++;
      continue;
    }

    out.push({
      question,
      expectFilename: doc.filename,
      reviewed: false,
      source: "generated",
      passage: passage.replace(/\s+/g, " ").slice(0, 320),
      answer: (parsed.answer ?? "").trim().slice(0, 240),
    });
    alreadyAsked.add(question.toLowerCase());
  }

  mkdirSync(dirname(CANDIDATES_PATH), { recursive: true });
  /* THE SAME AMBIGUITY ONE LEVEL UP.
   *
   * Excluding sibling FILES does not catch a shared activity described in two
   * unrelated ones. Both courses close with participants writing themselves a
   * congratulatory note, so two passages from different guides produced "what
   * activity involves writing a congratulatory note to themselves" and "what
   * activity involves writing a self-congratulatory note", each naming a
   * different file as the only right answer. Whichever the retriever finds,
   * one of those pairs marks it wrong.
   *
   * Both go. Keeping either would mean deciding which course owns an activity
   * they genuinely share. */
  const collided = collidingPairs(out);
  const final = out.filter((_, i) => !collided.has(i));

  mkdirSync(dirname(CANDIDATES_PATH), { recursive: true });
  writeFileSync(CANDIDATES_PATH, `${JSON.stringify(final, null, 2)}\n`);
  console.log(`${out.length} candidates written to ${CANDIDATES_PATH}`);
  console.log(`  ${skipped} passages skipped as boilerplate or unparseable`);
  console.log(`  ${selfAnswering} rejected for naming their own file`);
  console.log(`  ${collided.size} dropped as two near-identical questions naming different files`);
  console.log(`\nReview them, then move the good ones into ${PAIRS_PATH} with reviewed: true.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
