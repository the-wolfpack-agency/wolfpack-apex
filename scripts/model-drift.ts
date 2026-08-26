/**
 * The same questions, the same models, on a schedule, compared to last time.
 *
 * WHY THIS EXISTS. Every check this repo has answers "is it right now". None
 * answers "has it changed". A provider can update a model under a stable name,
 * a prompt edit can move every answer at once, a price can change, and a
 * latency can double, and each of those is invisible to a suite that asserts
 * behaviour rather than remembering it.
 *
 * That is the gap against the tools that sell continuous evaluation: not that
 * they test better, but that they test AGAIN and tell you what moved. A
 * point-in-time scan cannot detect drift by construction, however good it is.
 *
 * WHAT IT RECORDS, per model, per prompt: the answer, its cost, its latency,
 * the model identity the provider reported, and whether the response tripped
 * any of the shapes in response-safety. First run writes a baseline and asserts
 * nothing. Every run after compares.
 *
 * WHAT COUNTS AS DRIFT. Not "the wording changed" - a model is free to phrase
 * an answer differently and usually will. What matters is a change in KIND:
 *   - the provider now reports a different model for the same request
 *   - cost or latency moved by more than the tolerance
 *   - an answer that used to pass the checks now fails, or the reverse
 *   - a response newly trips a safety shape
 * Wording is reported as a similarity number and never fails the run on its
 * own, because failing on paraphrase trains people to ignore the alarm.
 *
 * Usage:
 *   npx tsx scripts/model-drift.ts                  # compare, exit 1 on drift
 *   npx tsx scripts/model-drift.ts --update         # accept current as baseline
 *   npx tsx scripts/model-drift.ts --pin deepseek   # a configured provider
 *
 * Baseline: demo/model-drift-baseline.json, committed on purpose so a change
 * in model behaviour shows up in a diff somebody reviews.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAIClient } from "@/lib/ai";
import { verifyAnswer } from "@/lib/ai/verification";
import { inspectResponse } from "@/lib/ai/response-safety";

const BASELINE = join(process.cwd(), "demo", "model-drift-baseline.json");

/* Deliberately dull and stable: questions whose right answer does not change
   week to week, so a difference is the model moving rather than the world. */
const PROMPTS = [
  "Reply with exactly the word: ready",
  "What is 17 multiplied by 23? Reply with only the number.",
  "List three primary colours, comma separated, nothing else.",
  "Summarise in one sentence: a dealer reported that two demo vehicles were double-booked for the same weekend.",
  "A customer asks whether their warranty covers a cracked windscreen. Answer in one sentence without promising anything.",
];

/* Enough movement to mean something, not so little that noise trips it. */
const COST_TOLERANCE = 0.5;
const LATENCY_TOLERANCE = 2.0;

interface Sample {
  prompt: string;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  sufficient: boolean;
  risks: string[];
  answer: string;
}

/** Token overlap, 0..1. A cheap stand-in for "the same kind of answer". */
function similarity(a: string, b: string): number {
  const t = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const [x, y] = [t(a), t(b)];
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size, 1);
}

async function collect(pin?: string): Promise<Sample[]> {
  const client = getAIClient();
  const out: Sample[] = [];
  for (const prompt of PROMPTS) {
    const started = Date.now();
    const res = await client.complete({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      model_tier: "cheap",
      ...(pin ? { provider_pin: pin } : {}),
      metadata: { feature: "model_drift", user_id: "drift-monitor", user_role: "system" },
    } as never);
    const verdict = verifyAnswer({ answer: res.content, question: prompt });
    out.push({
      prompt,
      model: res.model_used,
      provider: res.provider_used,
      costUsd: Number((res as { cost_usd?: number }).cost_usd ?? 0),
      latencyMs: Date.now() - started,
      sufficient: verdict.sufficient,
      risks: inspectResponse(res.content).map((f) => f.risk),
      answer: res.content,
    });
  }
  return out;
}

function compare(now: Sample[], before: Sample[]): string[] {
  const drift: string[] = [];
  for (const s of now) {
    const was = before.find((b) => b.prompt === s.prompt);
    if (!was) {
      drift.push(`NEW PROMPT (no baseline): ${s.prompt.slice(0, 48)}`);
      continue;
    }
    /* The identity change nothing else would catch: same request, same name in
       our config, different model behind it. */
    if (was.model !== s.model || was.provider !== s.provider) {
      drift.push(`MODEL CHANGED: ${was.provider}/${was.model} -> ${s.provider}/${s.model}`);
    }
    if (was.sufficient !== s.sufficient) {
      drift.push(
        `QUALITY ${s.sufficient ? "RECOVERED" : "REGRESSED"}: "${s.prompt.slice(0, 40)}" now ${s.sufficient ? "passes" : "fails"} the checks`,
      );
    }
    const newRisks = s.risks.filter((r) => !was.risks.includes(r));
    if (newRisks.length > 0) {
      drift.push(`NEW SAFETY FLAG on "${s.prompt.slice(0, 34)}": ${newRisks.join(", ")}`);
    }
    if (was.costUsd > 0 && Math.abs(s.costUsd - was.costUsd) / was.costUsd > COST_TOLERANCE) {
      drift.push(`COST MOVED: $${was.costUsd.toFixed(5)} -> $${s.costUsd.toFixed(5)}`);
    }
    if (was.latencyMs > 0 && s.latencyMs / was.latencyMs > LATENCY_TOLERANCE) {
      drift.push(`LATENCY MOVED: ${was.latencyMs}ms -> ${s.latencyMs}ms`);
    }
    /* Reported, never fatal on its own. */
    const sim = similarity(was.answer, s.answer);
    if (sim < 0.5) {
      console.log(`  wording changed (similarity ${sim.toFixed(2)}): "${s.prompt.slice(0, 42)}"`);
    }
  }
  return drift;
}

async function main(): Promise<void> {
  const pinIdx = process.argv.indexOf("--pin");
  const pin = pinIdx !== -1 ? process.argv[pinIdx + 1] : undefined;
  const update = process.argv.includes("--update");

  const now = await collect(pin);
  console.log(`\nSampled ${now.length} prompts on ${now[0]?.provider}/${now[0]?.model}\n`);
  for (const s of now) {
    console.log(
      `  ${s.sufficient ? "ok  " : "FAIL"} $${s.costUsd.toFixed(5)} ${String(s.latencyMs).padStart(5)}ms ${s.risks.length ? `RISK:${s.risks.join(",")} ` : ""}${s.prompt.slice(0, 44)}`,
    );
  }

  if (!existsSync(BASELINE) || update) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`\nBaseline written to ${BASELINE}. Nothing asserted on a first run.`);
    return;
  }

  const before: Sample[] = JSON.parse(readFileSync(BASELINE, "utf8"));
  const drift = compare(now, before);
  if (drift.length === 0) {
    console.log("\nNo drift. Same models, same verdicts, costs and latencies within tolerance.");
    return;
  }
  console.log(`\n${drift.length} change${drift.length === 1 ? "" : "s"} since the baseline:\n`);
  for (const d of drift) console.log(`  ${d}`);
  console.log("\nReview, then re-run with --update to accept these as the new baseline.");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
