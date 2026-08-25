/**
 * Did switching semantic on actually make the Brain better?
 *
 * WHY THIS IS NOT A UNIT TEST
 *
 * "Semantic is connected" and "answers improved" are different claims, and only
 * the first one is easy. A connected embedder that returns nothing useful still
 * shows a healthy config, a green health check and a rising token bill. This
 * asks the harder question against the queries people really typed.
 *
 * WHERE THE QUESTIONS COME FROM
 *
 * brain_query_log, not a list somebody invented. On 2026-08-24 it held 252 real
 * queries over 30 days: 192 answered by keyword alone, 60 that found nothing at
 * all, and zero with a semantic hit. Those 60 are the sharpest measure there is,
 * because every one of them is somebody who asked this product a question and
 * got nothing back.
 *
 * WHAT IT REPORTS
 *
 *   RESCUED    found nothing before, finds something now. The headline.
 *   CHANGED    both found something, semantic put a different document on top.
 *              Neither good nor bad on its own, so it is shown, not scored.
 *   UNCHANGED  same top document. Semantic agreed with keyword.
 *   LOST       found something before, finds nothing now. Must be zero.
 *
 * Run it BEFORE the backfill and again after. The before-run is the baseline,
 * and without one the after-run is a number with nothing to compare to, which
 * is how "it feels better" gets written down as a result.
 *
 *   npx tsx scripts/brain-eval.ts --save baseline.json
 *   npx tsx scripts/brain-eval.ts --against baseline.json
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  query: string;
  topDoc: string | null;
  keywordHits: number;
  semanticHits: number;
  quotable: boolean;
  /** Best score among the hits, so a verdict can be paired with a threshold. */
  topScore?: number;
  /** Set only with --judge. "returned something" is coverage; this is quality. */
  relevance?: string;
  reason?: string;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const { query } = await import("../src/lib/db");
  const { queryBrain } = await import("../src/lib/brain/query");
  const { carriesEnoughToQuote } = await import("../src/lib/brain/confidence");

  const limit = Number(arg("--limit") ?? 60);
  /* REAL QUESTIONS, NOT THE RED TEAM'S.
   *
   * The first version took DISTINCT query ORDER BY query, which is alphabetical
   * and therefore front-loaded with slash commands and the security suite's
   * payloads: card numbers, national insurance numbers, and prompts repeating
   * "the dealer replaced the BRAKE CALIPER" two hundred times. Those are in the
   * log because somebody tested this product, and "the assistant now returns a
   * document for a fabricated card number" is not an improvement anybody wants.
   *
   * Measuring against them made the headline look far better than the truth,
   * which is the one thing an eval must never do. */
  const log = await query<{ query: string }>(
    `SELECT DISTINCT query FROM brain_query_log
      WHERE created_at > now() - interval '90 days'
        AND length(query) BETWEEN 8 AND 120
        AND query NOT LIKE '/%'
        AND query !~ '[0-9]{4}[ -][0-9]{4}'
      ORDER BY query LIMIT $1`,
    [limit],
  );
  const questions = log.rows.map((r) => String(r.query));
  if (questions.length === 0) {
    console.error("No queries in brain_query_log to evaluate. Nothing to say.");
    process.exit(1);
  }

  /* THE JUDGE, ON THE CHEAP TIER.
   *
   * Coverage is the easy half. After the backfill this went from 9 of 60 real
   * questions answered to 45, and the first uncalibrated run said 60 of 60,
   * because a vector search with no floor answers everything. "Returned a
   * document" has never been the same claim as "returned the document that
   * answers the question", and no rule available here can tell them apart.
   *
   * Grading 60 retrievals on the cheap tier costs a fraction of a cent, which
   * is the router's argument in one line: on a premium-only stack this
   * measurement simply would not get done. */
  const judging = argv.includes("--judge");
  let judgeFn: ((q: string, m: string) => Promise<{ verdict: string; reason: string }>) | null = null;
  if (judging) {
    const { judgeRelevance } = await import("../src/lib/brain/relevance");
    const { getAIClient } = await import("../src/lib/ai/router");
    judgeFn = (q, m) =>
      judgeRelevance(q, m, async ({ system, prompt, maxTokens }) => {
        const res = await getAIClient().complete({
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          model_tier: "cheap",
          metadata: { feature: "brain.retrieval_eval", user_id: "eval", user_role: "system" },
        });
        return res.content;
      });
  }

  const rows: Row[] = [];
  for (const q of questions) {
    try {
      const r = await queryBrain({ query: q, limit: 5, userId: "eval", userRole: "system" });
      const top = r.hits[0];
      let relevance: string | undefined;
      let reason: string | undefined;
      if (judgeFn && top) {
        const verdict = await judgeFn(q, String(top.content ?? ""));
        relevance = verdict.verdict;
        reason = verdict.reason;
      }
      rows.push({
        query: q,
        topDoc: top ? String(top.document_filename) : null,
        keywordHits: r.keyword_hits,
        semanticHits: r.semantic_hits,
        quotable: carriesEnoughToQuote(q),
        topScore: top ? Number(top.score) : 0,
        ...(relevance ? { relevance, reason } : {}),
      });
    } catch (e) {
      rows.push({ query: q, topDoc: null, keywordHits: 0, semanticHits: 0, quotable: false });
      console.error(`  ! "${q.slice(0, 40)}": ${(e as Error).message.slice(0, 60)}`);
    }
  }

  const answered = rows.filter((r) => r.topDoc !== null).length;
  const withSemantic = rows.filter((r) => r.semanticHits > 0).length;
  console.log(`\n${rows.length} real queries from the log`);
  console.log(`  answered at all      ${answered}/${rows.length}`);
  console.log(`  with a semantic hit  ${withSemantic}/${rows.length}`);

  if (judging) {
    const graded = rows.filter((r) => r.relevance && r.relevance !== "unjudged");
    const good = graded.filter((r) => r.relevance === "relevant").length;
    const bad = graded.filter((r) => r.relevance === "irrelevant").length;
    const ungraded = rows.filter((r) => r.topDoc !== null && (!r.relevance || r.relevance === "unjudged")).length;
    console.log(`\njudged by a model on the cheap tier`);
    console.log(`  relevant     ${good}`);
    console.log(`  IRRELEVANT   ${bad}   (returned a document that does not answer the question)`);
    if (ungraded > 0) console.log(`  unjudged     ${ungraded}   (judge unreachable; counted as neither)`);
    if (answered > 0) {
      const pct = graded.length > 0 ? Math.round((good / graded.length) * 100) : 0;
      console.log(`  precision    ${pct}% of answered questions got a useful document`);
    }
    /* WHERE THE HONEST FLOOR IS. A verdict on its own says the retrieval was
       poor; a verdict paired with its score says what to do about it. */
    const rel = graded.filter((r) => r.relevance === "relevant").map((r) => r.topScore ?? 0).sort((a, b) => a - b);
    const irr = graded.filter((r) => r.relevance === "irrelevant").map((r) => r.topScore ?? 0).sort((a, b) => b - a);
    if (rel.length && irr.length) {
      /* THIS IS THE MERGED SCORE, NOT THE COSINE ONE. queryBrain blends the
         keyword and semantic hits, which is why values above 1.0 appear here
         and why this sweep cannot be used on its own to retune
         SEMANTIC_SCORE_FLOOR. It is shown because the OVERLAP is the finding:
         if the two populations cannot be separated even in principle, the
         answer is not a better threshold. */
      console.log(`\n  top merged score, not cosine (see note in source)`);
      console.log(`  relevant scores    ${rel[0].toFixed(4)} .. ${rel[rel.length - 1].toFixed(4)}`);
      console.log(`  irrelevant scores  ${irr[irr.length - 1].toFixed(4)} .. ${irr[0].toFixed(4)}`);
      let best = { floor: 0, kept: 0, cut: 0, precision: 0 };
      for (const f of [0.36, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
        const keptGood = rel.filter((x) => x >= f).length;
        const keptBad = irr.filter((x) => x >= f).length;
        const p = keptGood + keptBad > 0 ? keptGood / (keptGood + keptBad) : 0;
        console.log(`  floor ${f.toFixed(2)}  keeps ${keptGood}/${rel.length} relevant, ${keptBad}/${irr.length} irrelevant, precision ${Math.round(p * 100)}%`);
        if (p > best.precision || (p === best.precision && keptGood > best.kept)) {
          best = { floor: f, kept: keptGood, cut: keptBad, precision: p };
        }
      }
    }
    for (const r of rows.filter((x) => x.relevance === "irrelevant").slice(0, 8)) {
      console.log(`    - "${r.query.slice(0, 52)}" -> ${r.topDoc}  (${r.reason})`);
    }
  }

  const save = arg("--save");
  if (save) {
    writeFileSync(save, JSON.stringify(rows, null, 2));
    console.log(`\nbaseline written to ${save}. Run the backfill, then compare against it.`);
  }

  const against = arg("--against");
  if (against) {
    const before: Row[] = JSON.parse(readFileSync(against, "utf8"));
    const byQuery = new Map(before.map((b) => [b.query, b]));
    let rescued = 0, changed = 0, unchanged = 0, lost = 0;
    const rescuedList: string[] = [];
    for (const now of rows) {
      const was = byQuery.get(now.query);
      if (!was) continue;
      if (was.topDoc === null && now.topDoc !== null) {
        rescued++;
        rescuedList.push(`${now.query}  ->  ${now.topDoc}`);
      } else if (was.topDoc !== null && now.topDoc === null) lost++;
      else if (was.topDoc !== now.topDoc) changed++;
      else unchanged++;
    }
    console.log(`\nagainst ${against}`);
    console.log(`  RESCUED    ${rescued}   (found nothing before, finds something now)`);
    console.log(`  CHANGED    ${changed}   (different document on top)`);
    console.log(`  UNCHANGED  ${unchanged}`);
    console.log(`  LOST       ${lost}   (must be zero)`);
    for (const r of rescuedList.slice(0, 10)) console.log(`    + ${r}`);

    /* A regression is a failure, and an improvement of zero is a result worth
       failing on too: it means the backfill ran and changed nothing, which is
       the outcome most likely to be reported as success. */
    if (lost > 0) {
      console.error(`\n${lost} quer${lost === 1 ? "y" : "ies"} stopped finding anything. That is a regression.`);
      process.exit(1);
    }
    if (rescued === 0 && changed === 0) {
      console.error("\nNothing improved and nothing changed. Semantic is connected but is not contributing.");
      process.exit(1);
    }
  }
  process.exit(0);
}
void main();
