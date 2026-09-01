/**
 * Is the client walkthrough safe to run, and what should it say?
 *
 * Runs every prompt the capability contract promises through the real chat()
 * against this deployment's own data, and reports which of them deliver what
 * the guide we hand a client says they will.
 *
 * It separates two failures that look identical on a shared screen and need
 * opposite fixes:
 *
 *   WRONG SHAPE  the product does not do the promised thing. The guide is
 *                lying and either the product or the promise has to change.
 *   NOTHING TO   the product works and this deployment holds nothing to
 *   ANSWER WITH  answer with. The example needs grounding in a document the
 *                client actually has.
 *
 * Both blocked the 2026-08-31 walkthrough. The guide published "what does our
 * policy say about time off?" and "summarize the onboarding document" against
 * a corpus of 1,251 Porsche academy documents holding neither.
 *
 * Usage:
 *   npx tsx scripts/walkthrough.ts              # check the contract
 *   npx tsx scripts/walkthrough.ts --script     # also print the demo script
 *
 * Needs DATABASE_URL. Exits non-zero when the contract does not hold, so it
 * can gate a release rather than only inform a person.
 */
import "./load-env";

import { chat } from "@/lib/assistant";
import { MODULE_CAPABILITIES } from "@/lib/modules/capabilities";
import { query } from "@/lib/db";
import {
  judge,
  assessWalkthrough,
  describeReadiness,
  type PromisedPrompt,
  type ObservedAnswer,
  type PromisedShape,
} from "@/lib/deployment/walkthrough";

function promised(): PromisedPrompt[] {
  return MODULE_CAPABILITIES.flatMap((m) =>
    m.actions
      .filter((a) => a.status === "supported")
      .map((a) => ({
        id: a.id,
        prompt: a.example,
        returns: a.returns as PromisedShape,
        because: a.because,
      })),
  );
}

async function ask(prompt: string): Promise<ObservedAnswer> {
  const started = Date.now();
  const r = await chat(prompt, "walkthrough", "admin");
  const widget = (r as unknown as { widget?: { results?: unknown[]; items?: unknown[] } }).widget;
  const sources = (r as unknown as { sources?: unknown[] }).sources;
  return {
    text: String(r.response ?? ""),
    source: String(r.source ?? "unknown"),
    widgetRows: (widget?.results ?? widget?.items ?? []).length,
    sources: Array.isArray(sources) ? sources.length : 0,
    ms: Date.now() - started,
  };
}

/**
 * Topics this deployment can actually answer about.
 *
 * Read from the corpus rather than chosen, because the whole failure being
 * fixed is a demo built on documents somebody assumed were there. Topics come
 * from the indexed documents themselves, so a client's own vocabulary is what
 * ends up on screen.
 */
async function groundedTopics(limit = 8): Promise<string[]> {
  const { rows } = await query<{ topic: string; n: string }>(
    `SELECT lower(t) AS topic, count(*)::text AS n
       FROM brain_documents, unnest(topics) AS t
      WHERE status = 'indexed' AND length(t) > 3
      GROUP BY lower(t)
      HAVING count(*) >= 2
      ORDER BY count(*) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.topic);
}

async function main() {
  const prompts = promised();
  console.log(
    `Checking ${prompts.length} prompt(s) the capability contract promises, against this deployment.\n`,
  );

  const verdicts = [];
  for (const p of prompts) {
    const observed = await ask(p.prompt);
    const v = judge(p, observed);
    const mark =
      v.state === "delivers" ? "ok  " : v.state === "wrong-shape" ? "FAIL" : "thin";
    console.log(`  ${mark}  ${p.id.padEnd(22)} ${String(observed.ms).padStart(5)}ms  ${p.prompt.slice(0, 52)}`);
    verdicts.push(v);
  }

  const readiness = assessWalkthrough(verdicts);
  console.log(`\n${describeReadiness(readiness)}`);

  if (readiness.nothingToAnswerWith.length > 0) {
    const topics = await groundedTopics().catch(() => []);
    if (topics.length > 0) {
      console.log(
        `\nThis deployment CAN answer about: ${topics.join(", ")}.`,
        `\nGround the examples above in one of those before the walkthrough.`,
      );
    }
  }

  if (process.argv.includes("--script")) {
    console.log(`\n${"=".repeat(72)}\nWALKTHROUGH SCRIPT\n${"=".repeat(72)}`);
    for (const v of readiness.delivers) {
      console.log(`\nSay: "${v.prompt.prompt}"`);
      console.log(`What they see: ${v.prompt.because}`);
      console.log(`Verified just now: ${v.observed.ms}ms, ${v.observed.sources} source(s).`);
    }
    if (readiness.nothingToAnswerWith.length > 0) {
      console.log(
        `\nDo NOT demonstrate these until they are grounded in a real document:\n` +
          readiness.nothingToAnswerWith.map((v) => `  "${v.prompt.prompt}"`).join("\n"),
      );
    }
  }

  process.exit(readiness.contractHolds ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
