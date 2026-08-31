/**
 * Prove a model from the Azure AI Foundry catalog before adding it.
 *
 * WHY THIS EXISTS. The catalog has hundreds of models and this product uses
 * two. That is not a limit of the architecture: a Foundry model is a registry
 * entry plus a deployment name, and the endpoint and key are already
 * configured in production. The limit was that nothing made trying one cheap,
 * so nobody did, and the router has picked the same model 99.8 per cent of the
 * time since April.
 *
 * This is the loop that makes it a five-minute job:
 *
 *   1. Deploy a model in Foundry, note the deployment name.
 *   2. npx tsx scripts/try-model.ts <deployment-name>
 *   3. Read what came back: does it answer, how fast, how much.
 *   4. If it holds up, add a registry entry with the measured numbers.
 *
 * WHAT IT MEASURES AND WHAT IT REFUSES TO. It sends real prompts of the shape
 * this product actually runs and reports latency, token counts and whether the
 * answer is usable. It does NOT decide whether a model is good enough: that is
 * a judgment about a client's questions, and a script that scored it would be
 * inventing a threshold nobody agreed.
 *
 * IT NEVER GUESSES A PRICE. Prices come from the catalog at the time you add
 * the model, and the registry entry it prints leaves them for you to fill in.
 * A wrong price does not fail loudly; it silently reorders every routing
 * decision the product makes.
 *
 * Usage:
 *   npx tsx scripts/try-model.ts phi-4-mini
 *   npx tsx scripts/try-model.ts ministral-3b --prompt "summarize this in one line: ..."
 *
 * Needs AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY, both of which
 * are already set in production.
 */

const ENDPOINT = process.env.AZURE_AI_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
const API_KEY = process.env.AZURE_AI_FOUNDRY_API_KEY;

/**
 * Prompts shaped like the product's real traffic, not like a benchmark.
 *
 * 87 per cent of calls are the cheap tier: short, grounded, answered from
 * retrieved text. A model that handles these is a candidate; one that needs a
 * paragraph of coaxing is not, whatever it scores elsewhere.
 */
const PROBES: Array<{ name: string; system: string; user: string }> = [
  {
    name: "grounded answer",
    system:
      "Answer only from the context. If the context does not contain the answer, say so plainly.",
    user:
      "Context: The statement of work sets payment terms at net 30 from invoice date, with a 2% early-settlement discount inside 10 days.\n\nQuestion: what are the payment terms?",
  },
  {
    name: "refuses what it was not told",
    system:
      "Answer only from the context. If the context does not contain the answer, say so plainly.",
    user:
      "Context: The statement of work sets payment terms at net 30 from invoice date.\n\nQuestion: what is the late-payment penalty?",
  },
  {
    name: "short instruction following",
    system: "Reply with exactly one sentence and no preamble.",
    user: "Summarize: the team shipped seventeen fixes, most found by measuring production rather than reading code.",
  },
];

interface Outcome {
  probe: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  answer: string;
}

async function callFoundry(
  deployment: string,
  system: string,
  user: string,
): Promise<Outcome & { probe: string }> {
  const started = Date.now();
  /* Foundry serves an OpenAI-compatible chat completions route per deployment,
     which is why a new model needs no new client code. */
  const url = `${ENDPOINT}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-08-01-preview`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": API_KEY! },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 300,
        temperature: 0,
      }),
    });

    const ms = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return { probe: "", ok: false, ms, answer: `HTTP ${res.status}: ${text}` };
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      probe: "",
      ok: true,
      ms,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      answer: (body.choices?.[0]?.message?.content ?? "").trim(),
    };
  } catch (err) {
    return {
      probe: "",
      ok: false,
      ms: Date.now() - started,
      answer: `threw: ${(err as Error).message.slice(0, 160)}`,
    };
  }
}

async function tryModel() {
  const deployment = process.argv[2];
  if (!deployment) {
    console.error("usage: npx tsx scripts/try-model.ts <foundry-deployment-name>");
    process.exit(2);
  }
  if (!ENDPOINT || !API_KEY) {
    console.error(
      "Needs AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY.\n" +
        "Both are set in production; pull them into your env to run this locally.",
    );
    process.exit(2);
  }

  console.log(`Trying "${deployment}" against ${PROBES.length} prompts shaped like real traffic.\n`);

  const results: Outcome[] = [];
  for (const p of PROBES) {
    const r = await callFoundry(deployment, p.system, p.user);
    results.push({ ...r, probe: p.name });
    console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${p.name.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${
      r.inputTokens !== undefined ? `${r.inputTokens}in/${r.outputTokens}out` : ""
    }`);
    console.log(`        ${r.answer.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
  console.log(`\n${okCount}/${results.length} answered, average ${avgMs}ms.`);

  if (okCount === 0) {
    console.error(
      "\nNothing answered. Check the deployment name matches Foundry exactly, " +
        "and that the deployment has finished provisioning.",
    );
    process.exit(1);
  }

  /* THE REGISTRY ENTRY, WITH THE PRICES LEFT BLANK ON PURPOSE. A guessed price
     does not fail loudly, it silently reorders every routing decision the
     product makes, so it is the one field this refuses to fill in. */
  console.log(
    `\nIf it holds up, add this to src/lib/ai/models/registry.ts and set\n` +
      `AZURE_FOUNDRY_DEPLOYMENT_<NAME> in Vercel:\n\n` +
      `  {\n` +
      `    id: "azure-${deployment}",\n` +
      `    provider: "azure",\n` +
      `    endpointEnvVar: "AZURE_AI_FOUNDRY_ENDPOINT",\n` +
      `    apiKeyEnvVar: "AZURE_AI_FOUNDRY_API_KEY",\n` +
      `    deploymentEnvVar: "AZURE_FOUNDRY_DEPLOYMENT_<NAME>",\n` +
      `    capabilityTier: "small",   // "small" only if it passed the grounded probes\n` +
      `    contextWindow: 0,          // from the catalog\n` +
      `    inputPricePer1kUsd: 0,     // from the catalog, do not guess\n` +
      `    outputPricePer1kUsd: 0,    // a wrong price reorders every routing decision\n` +
      `  },\n`,
  );
  process.exit(0);
}

tryModel().catch((err) => {
  console.error(err);
  process.exit(1);
});
