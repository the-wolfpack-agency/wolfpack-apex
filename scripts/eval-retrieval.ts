/**
 * Grade the FULL retrieval path against known-correct answers.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 *
 * It needs an embedding deployment. Run locally without one, queryBrain skips
 * the semantic half entirely and grades the keyword side alone, which is half
 * the product: measured that way on 2026-08-29 the corpus scored 40% recall,
 * and reporting that as the product's recall would have been wrong by
 * construction.
 *
 * So it runs where the real configuration is. In CI that is the workflow with
 * the production secrets; locally it is a shell with AZURE_OPENAI_EMBEDDING_
 * DEPLOYMENT set. It REFUSES to run without one rather than silently grading
 * half the system, because a number that quietly measures something else is
 * worse than no number.
 *
 * WHAT IT IS FOR
 *
 * FILENAME_MATCH_WEIGHT is 9 because 0.1 x 9 clears a semantic score of 0.45.
 * Nothing says whether 6 or 12 serves real questions better, and the standard
 * answer to two incomparable scales is Reciprocal Rank Fusion, which would
 * change ranking for every question in the corpus. This is how that change
 * gets judged instead of argued.
 *
 * Usage:
 *   npx tsx scripts/eval-retrieval.ts pairs.json
 *
 * pairs.json: [{ "question": "...", "expectFilename": "..." }]
 * Deployment-specific by design: a client's own eval set is the only one that
 * can tell them their deployment works.
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { readFileSync } from "node:fs";
import { retrieve } from "@/lib/brain/retrieve";
import { judgeRelevance } from "@/lib/brain/relevance";
import { getAIClient } from "@/lib/ai/router";
import {
  EXPANSION_SYSTEM,
  EXPANSION_MAX_TOKENS,
  parseExpansion,
} from "@/lib/brain/expand-query";
import { RELEVANCE_MATERIAL_PER_HIT } from "@/lib/brain/relevance";
import { isEmbeddingConfigured } from "@/lib/brain/embedder";
import { query } from "@/lib/db";
import { mapWithConcurrency } from "@/lib/search/providers/util";
import {
  gradeRetrieval,
  describeEval,
  type LabelledPair,
  type RankedResult,
} from "@/lib/brain/retrieval-eval";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npx tsx scripts/eval-retrieval.ts pairs.json');
    process.exit(2);
  }

  /* REFUSES RATHER THAN GRADING HALF. Without embeddings queryBrain returns
     keyword hits only, and the resulting number describes a system nobody
     ships. */
  if (!isEmbeddingConfigured()) {
    console.error(
      "No embedding deployment configured, so only the keyword half would run.\n" +
        "That grades half the product and the number would not mean what it says.\n" +
        "Set AZURE_OPENAI_EMBEDDING_DEPLOYMENT (and the Azure OpenAI key/endpoint),\n" +
        "or run this in CI where the production secrets are.",
    );
    process.exit(2);
  }

  const pairs = JSON.parse(readFileSync(path, "utf8")) as LabelledPair[];
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error("No labelled pairs. An empty eval set scores zero, not perfect.");
    process.exit(2);
  }

  /* Any indexed user, since retrieval is audience-scoped and an eval run needs
     a role that can see the corpus it is grading. */
  const u = await query<{ id: string; role: string }>(
    `SELECT id, role FROM instinct_team_members WHERE is_active = true ORDER BY created_at LIMIT 1`,
  );
  const me = u.rows[0];
  if (!me) {
    console.error("No active user to run retrieval as.");
    process.exit(2);
  }

  /* CONCURRENT, BOUNDED. Sequential was fine for six pairs and will not hold
     at two hundred: each one is a Postgres query plus an embedding call plus a
     Qdrant search, so a serial run is minutes of mostly waiting. Bounded so an
     eval cannot behave like a load test against the same index the product is
     serving from, and reusing the search helper rather than growing a second
     concurrency primitive. */
  const EVAL_CONCURRENCY = 6;
  /* EXPAND=1 measures the rewrite path. Off by default so the baseline is the
     product as it ships, and a comparison is two runs of the same command. */
  const expanding = process.env.EXPAND === "1";
  const expand = async (question: string): Promise<string> => {
    const res = await getAIClient().complete({
      messages: [{ role: "user", content: question }],
      system: EXPANSION_SYSTEM,
      max_tokens: EXPANSION_MAX_TOKENS,
      model_tier: "cheap",
      metadata: { feature: "brain.query_expansion" },
    });
    return parseExpansion(res.content, question);
  };

  /* THE SAME LOOP THE ASSISTANT RUNS. Previously this called queryBrain
     directly, so it graded a path the product does not take: query expansion
     triggers on a JUDGE rejection, and the only harness that could have tested
     it never called the judge. A measurement that grades a different path than
     the one that runs is worse than none, because it reports numbers with the
     authority of a test. */
  const judge = async (question: string, hits: Array<{ content: string }>) => {
    const material = hits
      .slice(0, 3)
      .map((h) => h.content.slice(0, RELEVANCE_MATERIAL_PER_HIT))
      .join("\n\n");
    const r = await judgeRelevance(question, material, async (input) => {
      const res = await getAIClient().complete({
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        max_tokens: input.maxTokens,
        model_tier: "cheap",
        metadata: { feature: "brain.retrieval_relevance" },
      });
      return res.content;
    });
    return r.verdict;
  };

  let expandedCount = 0;
  let helpedCount = 0;
  const results = await mapWithConcurrency(pairs, EVAL_CONCURRENCY, async (p) => {
    const r = await retrieve({
      userId: me.id,
      userRole: me.role,
      query: p.question,
      limit: 8,
      ...(expanding ? { judge, expand } : {}),
    });
    if (r.expanded) expandedCount++;
    if (r.expansionHelped) helpedCount++;
    return {
      question: p.question,
      hits: r.execution.hits.map((h) => ({ filename: String(h.document_filename ?? "") })),
    };
  });
  if (expanding) {
    console.log(`  expansion fired on ${expandedCount} of ${pairs.length}, helped ${helpedCount}\n`);
  }
  const cache = new Map<string, RankedResult[]>(results.map((r) => [r.question, r.hits]));

  const report = gradeRetrieval(pairs, (q) => cache.get(q) ?? []);
  console.log("Full retrieval, keyword + semantic:\n");
  for (const o of report.outcomes) {
    console.log(`  rank ${String(o.rank ?? "-").padStart(2)}   ${o.pair.question.slice(0, 60)}`);
  }
  console.log(`\n  ${describeEval(report)}`);
  if (report.misses.length > 0) {
    console.log("\n  Never found:");
    for (const m of report.misses) console.log(`    - ${m.question}  (wanted ${m.expectFilename})`);
  }
  /* Exits 0 either way: this reports a measurement, it does not gate a merge.
     A ranking that scores badly is information, not a broken build. */
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
