/**
 * Prove a cross-family agent-to-agent handoff THROUGH the governance layer,
 * against a REAL environment.
 *
 *   npm run a2a:proof -- "your prompt here"
 *
 * Agent A (Claude, the originator) hands a task to a different-family Agent B
 * (Azure-hosted) via the model router, then an independent-family judge scores
 * B's answer. Prints the full evidence envelope: what was delivered, by whom, at
 * what cost, and the independent verdict.
 *
 * This is the demo for the thesis that the router + gate is the missing trust
 * layer under A2A / MCP: those move the bytes, this supplies identity-scoped
 * routing, egress control, budget governance, and a bias-removing independent
 * check. Honest by design: a provider that is not configured shows up as a
 * recorded "not delivered" with the exact env var to set, never a fake success.
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { getAIClient } from "@/lib/ai";
import { buildRegistry, judgeCandidates } from "@/lib/ai/router";
import { runCrossFamilyHandoff } from "@/lib/ai/a2a-proof";

function line(label: string, value: string | number | boolean | null): void {
  console.log(`  ${label.padEnd(20)} ${value === null ? "(none)" : value}`);
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim() || "In one sentence, what is the capital of France and why is it significant?";

  const client = getAIClient();
  // Use the ACTUALLY-configured providers as judge candidates (the judge runs
  // at the cheap tier), so a configured DeepSeek/Foundry model is considered -
  // instead of a hardcoded list that never saw it.
  const candidates = judgeCandidates(buildRegistry(), "cheap");
  const ev = await runCrossFamilyHandoff(
    { prompt, targetProviderPin: "azure-openai", judgeCandidates: candidates },
    { complete: (req) => client.complete(req) },
  );

  console.log("\n=== cross-family agent-to-agent handoff (through the layer) ===\n");
  console.log(`Agent A: ${ev.agentA.identity}  [${ev.agentA.model}, lineage=${ev.agentA.lineage}]`);
  console.log(`Prompt : ${ev.prompt}\n`);

  console.log("Agent B delivery (pinned to a different family):");
  line("delivered", ev.agentB.delivered);
  line("model", ev.agentB.modelUsed);
  line("provider", ev.agentB.providerUsed);
  line("input tokens", ev.agentB.inputTokens);
  line("output tokens", ev.agentB.outputTokens);
  line("cost usd", ev.agentB.costUsd);
  line("latency ms", ev.agentB.latencyMs);
  if (ev.agentB.answer) console.log(`  answer               ${ev.agentB.answer.replace(/\n/g, " ")}`);
  if (ev.agentB.error) console.log(`  error                ${ev.agentB.error}`);

  console.log("\nIndependent-family check (bias removal):");
  line("author lineage", ev.independentCheck.authorLineage);
  line("judge lineage", ev.independentCheck.judgeLineage);
  line("independent", ev.independentCheck.independent);
  line("selection reason", ev.independentCheck.selectionReason);
  line("judged", ev.independentCheck.judged);
  line("verdict", ev.independentCheck.verdict);
  line("sound", ev.independentCheck.sound);
  if (ev.independentCheck.reason) console.log(`  judge reason         ${ev.independentCheck.reason}`);
  if (ev.independentCheck.error) console.log(`  check error          ${ev.independentCheck.error}`);

  console.log(`\nWhat the layer added:\n  ${ev.layerNote}\n`);

  // A run that could not deliver OR could not run an independent check has not
  // proven the thesis. Exit non-zero so a green exit always means a real,
  // independently-checked cross-family delivery happened.
  const proven = ev.agentB.delivered && ev.independentCheck.independent && ev.independentCheck.judged;
  if (!proven) {
    console.log("NOT PROVEN in this environment. To light up a live cross-family hop, configure:");
    if (!ev.agentB.delivered) {
      console.log("  - Agent B (Azure): AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + a CHAT deployment");
      console.log("    (AZURE_OPENAI_DEPLOYMENT_STANDARD or _CHEAP), or the Foundry vars for DeepSeek/Llama.");
    }
    if (!ev.independentCheck.independent || !ev.independentCheck.judged) {
      console.log("  - Independent judge (Anthropic): ANTHROPIC_API_KEY");
    }
    console.log("");
    process.exit(1);
  }
  console.log("PROVEN: a real cross-family delivery, independently checked, with a full evidence trail.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
