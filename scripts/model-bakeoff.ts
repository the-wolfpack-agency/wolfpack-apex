/**
 * The same prompts, across every model this deployment can actually reach.
 *
 * WHY THIS EXISTS. The router has carried tiered routing, independent-judge
 * selection and a comparison engine for months, and production has served
 * gpt-4o-mini for every one of its calls. Not because the other models are
 * unconfigured - DeepSeek and Llama have their endpoint, key and deployment
 * name set - but because they sit at the LARGE tier and essentially all
 * traffic classifies as cheap. 194 cheap, 62 standard, 1 premium.
 *
 * So "our router is efficient across models" has been a claim about a
 * capability nothing exercised. This exercises it, and prints the numbers that
 * either support the claim or do not.
 *
 * NOT A PLAYGROUND. Every leg goes through the same chokepoint production
 * uses, so each answer arrives redacted, inside the workspace budget, obeying
 * residency, with the provider's own billed figure attached and the same
 * verification rules that guard live traffic. The output is evidence rather
 * than an impression.
 *
 * WHAT TO READ. cheapest-sufficient is the whole argument: for each prompt,
 * the least expensive model whose answer passed the checks. If that is the
 * small model on most of your real work, routing cheap is justified with
 * numbers. If it is not, the router should stop doing it, and this is how you
 * would know.
 *
 * Usage:
 *   npx tsx scripts/model-bakeoff.ts
 *   npx tsx scripts/model-bakeoff.ts --file prompts.txt
 *   npx tsx scripts/model-bakeoff.ts --tiers cheap,standard,premium
 *
 * Needs: DATABASE_URL and the provider credentials. Models that are not
 * configured are reported as such rather than skipped silently.
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { readFileSync } from "node:fs";
import { runComparison, COMPARISON_MAX_TOKENS } from "@/lib/ai/comparison";
import { getAIClient } from "@/lib/ai";
import { MODEL_REGISTRY, isModelAvailable } from "@/lib/ai/models/registry";
import type { AIModelTier } from "@/lib/ai/types";

/* Work this team actually does, not a benchmark from somebody else. A model
   that writes a good sonnet and a poor meeting summary is the wrong model. */
const DEFAULT_PROMPTS = [
  "Summarise this in two sentences: the dealer review covered Q3 delivery targets, two Centers behind on CRM hygiene, and a request for more demo vehicles in the northeast.",
  "Turn this into three bullet points a manager can act on: survey responses say facilitators were strong, the venue was too cold, and the afternoon session ran long.",
  "Extract the action items: Jorge will send the updated roster, Ashley is chasing the Novi paperwork, and someone needs to confirm the Chantilly dates.",
  "A dealer asks how to register a demo vehicle for two consecutive weekends. Answer in three sentences.",
  "Classify the sentiment and name the single biggest complaint: 'The training was useful but the room was freezing and lunch was late.'",
];

function prompts(): string[] {
  const i = process.argv.indexOf("--file");
  if (i !== -1 && process.argv[i + 1]) {
    return readFileSync(process.argv[i + 1], "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  return DEFAULT_PROMPTS;
}

function tiers(): AIModelTier[] {
  const i = process.argv.indexOf("--tiers");
  const raw = i !== -1 ? process.argv[i + 1] : "cheap,standard,premium";
  return raw.split(",").map((t) => t.trim()) as AIModelTier[];
}

function reachable(): void {
  console.log("Models this deployment can reach:\n");
  let any = false;
  for (const m of MODEL_REGISTRY) {
    const ok = isModelAvailable(m, process.env);
    if (ok) any = true;
    console.log(`  ${ok ? "yes" : "no "}  ${m.id.padEnd(24)} ${String(m.capabilityTier).padEnd(10)} ${m.provider}`);
  }
  if (!any) {
    /* THE CATALOGUE IS STRICTER THAN THE PROVIDER, ON PURPOSE.
     *
     * A model counts as reachable only when its deployment name has been set.
     * The Azure provider will fall back to a default name (gpt-4o-mini,
     * gpt-4o, gpt-4) and that is how this deployment has been answering, but
     * defaulting the NAME does not mean the deployment EXISTS: on a resource
     * without it the call 404s at runtime. Reporting a model available on a
     * guess would be the catalogue telling a comfortable story.
     *
     * So this says what is missing rather than proceeding hopefully. */
    console.log(
      "\nNo model has a confirmed deployment name, so nothing here can be compared.\n" +
        "The router may still answer using the provider's default deployment - that is\n" +
        "how production serves gpt-4o-mini today - but a default is a guess, and a\n" +
        "comparison built on guesses is not evidence.\n\n" +
        "Set the deployment variables for the models you want measured:\n" +
        "  AZURE_OPENAI_DEPLOYMENT_CHEAP / _STANDARD / _PREMIUM   (Azure OpenAI)\n" +
        "  AZURE_AI_FOUNDRY_ENDPOINT + AZURE_AI_FOUNDRY_API_KEY\n" +
        "  AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK / _LLAMA             (Foundry)\n" +
        "  ANTHROPIC_API_KEY                                      (Claude)\n",
    );
    process.exit(1);
  }
  console.log("");
}

async function main(): Promise<void> {
  reachable();
  const client = getAIClient();
  const list = prompts();
  const wanted = tiers();

  const perModel = new Map<string, { wins: number; runs: number; cost: number; ms: number; failures: number }>();
  let totalSaving = 0;
  let comparable = 0;

  for (const [n, prompt] of list.entries()) {
    console.log(`\n${"=".repeat(74)}\n${n + 1}. ${prompt.slice(0, 68)}\n${"=".repeat(74)}`);
    const res = await runComparison(
      { prompt, tiers: wanted, maxTokens: COMPARISON_MAX_TOKENS, metadata: { feature: "model_bakeoff" } },
      (req) => client.complete(req),
    );

    for (const leg of res.legs) {
      const k = leg.model || `${leg.provider}:${leg.tier}`;
      const acc = perModel.get(k) ?? { wins: 0, runs: 0, cost: 0, ms: 0, failures: 0 };
      acc.runs += 1;
      acc.cost += leg.costUsd;
      acc.ms += leg.latencyMs;
      if (leg.failed) acc.failures += 1;
      perModel.set(k, acc);

      const status = leg.failed
        ? `unavailable: ${leg.failed.reason}`
        : `${leg.verdict.sufficient ? "sufficient" : `INSUFFICIENT (${leg.verdict.flags.join(",")})`}`;
      console.log(
        `  ${leg.tier.padEnd(9)} ${(leg.model || "-").padEnd(22)} ${`$${leg.costUsd.toFixed(5)}`.padEnd(10)} ${`${leg.latencyMs}ms`.padEnd(8)} ${status}`,
      );
    }

    if (res.cheapestSufficient) {
      const acc = perModel.get(res.cheapestSufficient);
      if (acc) acc.wins += 1;
      comparable += 1;
      if (res.savingPerCallUsd != null) totalSaving += res.savingPerCallUsd;
      console.log(`  -> cheapest sufficient: ${res.cheapestSufficient}`);
    } else {
      console.log("  -> nothing passed the checks");
    }
  }

  console.log(`\n\n${"=".repeat(74)}\nAcross ${list.length} prompts\n${"=".repeat(74)}`);
  console.log(`${"model".padEnd(24)} ${"cheapest-sufficient".padEnd(20)} ${"avg cost".padEnd(11)} ${"avg ms".padEnd(8)} failures`);
  for (const [model, a] of [...perModel.entries()].sort((x, y) => y[1].wins - x[1].wins)) {
    const ran = Math.max(a.runs - a.failures, 1);
    console.log(
      `${model.padEnd(24)} ${String(a.wins).padEnd(20)} ${`$${(a.cost / ran).toFixed(5)}`.padEnd(11)} ${String(Math.round(a.ms / ran)).padEnd(8)} ${a.failures}`,
    );
  }
  if (comparable > 0) {
    console.log(
      `\nRouting to the cheapest sufficient model saves $${totalSaving.toFixed(5)} per call, averaged over ${comparable} comparable prompts.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
