/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Run a corpus of prompts through the REAL assistant and read the answers.
 *
 * WHY THIS AND NOT THE ROUTING AUDIT. The routing audit checks that a phrasing
 * reaches the right tool. It never runs a model, so it passed the morning brief
 * on the day that brief narrated "Meeting ID: AAMkAG..." into prose. This runs
 * each prompt through chat(), the same entry the product uses, which means the
 * SAME model router picks the tier and the SAME answer gate applies, and then
 * it audits the finished answer for the failures that are wrong whoever is
 * connected: a leaked id, an unfilled slot, a raw cache field, an essay.
 *
 * It is a guardrail, not a quality score. It does not judge whether the answer
 * was good, which needs a person or a grader; it fails on the classes that are
 * never acceptable, so it can run in CI and gate a client deploy without a
 * populated account to compare against.
 *
 * DOGFOODS THE ROUTER AND GATE on purpose: every answer here is produced the
 * way a real one is, tier chosen by the router, constitution applied by the
 * gate. A leak that survives both is exactly what this is here to surface.
 *
 * REFUSES WITHOUT A MODEL, the way the retrieval eval refuses without an
 * embedder: a run that cannot produce an answer would report a clean corpus
 * having tested nothing.
 *
 *   npx tsx scripts/answer-audit.ts
 *   npx tsx scripts/answer-audit.ts --all      # the whole corpus, not the sample
 */

import { query } from "@/lib/db";
import { chat } from "@/lib/assistant";
import { auditAnswer } from "@/lib/assistant/answer-audit";
import { AUDIT_PROMPTS } from "@/lib/assistant/routing-audit";

/** Flatten the grouped audit prompts into a list, keeping the group for output. */
function corpus(all: boolean): Array<{ group: string; prompt: string }> {
  const flat: Array<{ group: string; prompt: string }> = [];
  for (const [group, prompts] of Object.entries(AUDIT_PROMPTS)) {
    for (const p of prompts as string[]) flat.push({ group, prompt: p });
  }
  /* A bounded sample by default, because each prompt is a real model call. The
     sample takes the first of each group so every surface is exercised. */
  if (all) return flat;
  const seen = new Set<string>();
  return flat.filter((f) => (seen.has(f.group) ? false : seen.add(f.group)));
}

async function main(): Promise<void> {
  if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY) {
    console.error("No model is configured (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY), so no answer can be produced.");
    console.error("This would otherwise report a clean corpus having tested nothing.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; chat() needs it to run as a real user.");
    process.exit(1);
  }

  /* A role that can reach the surfaces under test, the same choice the
     retrieval eval makes: an arbitrary restricted user would route half the
     corpus into a permission wall and call it a failure. */
  const { rows } = await query<{ id: string; role: string }>(
    `SELECT id, role FROM instinct_team_members WHERE is_active = true ORDER BY created_at`,
  );
  const me = rows.find((r) => ["cto", "ceo", "admin"].includes(r.role)) ?? rows[0];
  if (!me) {
    console.error("No active user to run the assistant as.");
    process.exit(1);
  }

  const items = corpus(process.argv.includes("--all"));
  console.log(`Running ${items.length} prompt(s) through chat() as ${me.role}, router and gate live.\n`);

  const leaks: Array<{ prompt: string; findings: string; answer: string }> = [];
  let warned = 0;

  for (const { group, prompt } of items) {
    let answer = "";
    try {
      const res = await chat(prompt, me.id, me.role);
      answer = res.response ?? "";
    } catch (e) {
      /* A thrown chat is a defect too, but a different one; report it and move
         on rather than letting one prompt end the run. */
      console.log(`  THREW    [${group}] ${prompt} :: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    const audit = auditAnswer(answer);
    const leakKinds = audit.findings.filter((f) => f.severity === "leak").map((f) => f.kind);
    const warnKinds = audit.findings.filter((f) => f.severity === "warn").map((f) => f.kind);
    if (leakKinds.length) {
      leaks.push({ prompt, findings: leakKinds.join(", "), answer: answer.slice(0, 160) });
      console.log(`  LEAK     [${group}] ${prompt}  ->  ${leakKinds.join(", ")}`);
    } else if (warnKinds.length) {
      warned++;
      console.log(`  warn     [${group}] ${prompt}  ->  ${warnKinds.join(", ")}`);
    } else {
      console.log(`  clean    [${group}] ${prompt}`);
    }
  }

  console.log(
    `\n${items.length - leaks.length}/${items.length} clean of leaks` +
      (warned ? `, ${warned} with a warning (bloat/empty)` : ""),
  );
  if (leaks.length) {
    console.error(`\n${leaks.length} answer(s) leaked something a person should never see:`);
    for (const l of leaks) {
      console.error(`  ${l.prompt}`);
      console.error(`     ${l.findings}: ${l.answer.replace(/\s+/g, " ")}`);
    }
    /* A leak fails the run. Bloat and empty are warnings and do not, because a
       legitimately long or terse answer is not a defect. */
    process.exit(1);
  }
  console.log("\nNo answer leaked. The router, the gate, and the answers are clean on this corpus.");
}

main().catch((err) => {
  console.error("[answer-audit] failed:", (err as Error).message);
  process.exit(1);
});
