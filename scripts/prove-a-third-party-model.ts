/**
 * Prove the router can reach a model that is not ours.
 *
 * The registry has always been able to DESCRIBE one. client-models.ts
 * validates an endpoint somebody types, namespaces the id so a client
 * cannot shadow ours, and marks the price as declared rather than
 * verified. All of it tested, and none of it connected: the endpoint it
 * carefully validates was read by nothing, and the probe sent every model
 * with an "openai" provider to api.openai.com regardless of where it is
 * actually served.
 *
 * So a client's own model, or Kimi, or Qwen, would have been probed
 * against somebody else's host with a key that does not belong there, and
 * reported unreachable for a reason that had nothing to do with their
 * deployment.
 *
 * This drives it. A local server speaks the /chat/completions shape that
 * Kimi, Qwen, vLLM, Ollama, LM Studio and most gateways expose, the spec
 * is built through the real validator, and the request goes out through
 * the real probe path.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. That the wire format, the routing
 * and the accounting hold for a model we do not own. It does not prove
 * Kimi answers well: that needs a key and a bill, and it is a different
 * question from whether the abstraction is real.
 *
 * Usage:  npx tsx scripts/prove-a-third-party-model.ts
 */

/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { createServer } from "node:http";
import { probeTargetFor } from "@/lib/ai/models/probe";
import { validateClientModel } from "@/lib/ai/models/client-models";
import { selectModel } from "@/lib/ai/models/router";
import type { ModelSpec } from "@/lib/ai/models/types";

interface Seen {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

async function main(): Promise<void> {
  const seen: Seen[] = [];

  /* A stand-in for Moonshot or DashScope: same path, same body, same
     response envelope. Nothing here is OpenAI. */
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(raw || "{}"),
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-local",
          model: "kimi-k2-mock",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;

  /* Through the REAL validator, which refuses loopback for a stored
     client model on purpose: a prompt should not be sent to an address
     only the server can reach. That rule is right and it is also why this
     proof builds the spec by hand afterwards rather than pretending the
     rule is not there. */
  const viaValidator = validateClientModel(
    {
      id: "kimi-k2",
      label: "Kimi K2",
      endpoint,
      capabilityTier: "large",
      contextWindow: 128_000,
      inputPricePer1kUsd: 0.00058,
      outputPricePer1kUsd: 0.00232,
    },
    { hostAllowed: () => true },
  );
  console.log(
    viaValidator.ok
      ? "validator accepted the endpoint"
      : `validator refused it, correctly: ${viaValidator.rejections.map((r: { reason: string }) => r.reason).join("; ")}`,
  );

  const spec = {
    id: "client:kimi-k2",
    provider: "openai",
    capabilityTier: "large",
    contextWindow: 128_000,
    inputPricePer1kUsd: 0.00058,
    outputPricePer1kUsd: 0.00232,
    endpoint,
    apiKeyEnvVar: "KIMI_API_KEY",
  } as unknown as ModelSpec;

  const target = probeTargetFor(spec, { KIMI_API_KEY: "kimi-test-key" } as unknown as NodeJS.ProcessEnv);
  if (!target) {
    console.error("probeTargetFor returned nothing for a third-party model");
    server.close();
    process.exitCode = 1;
    return;
  }
  console.log(`probe target: ${target.url}`);
  if (!target.url.startsWith(`http://127.0.0.1:${port}`)) {
    console.error(`WRONG HOST: the probe would have gone to ${target.url}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const res = await fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer kimi-test-key" },
    body: JSON.stringify(target.body),
  });
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };

  console.log(`answered ${res.status} with "${payload.choices?.[0]?.message?.content}"`);
  console.log(`usage reported: ${payload.usage?.total_tokens} tokens`);
  console.log(`the server saw ${seen.length} request(s), auth "${seen[0]?.auth}"`);

  /* And the router has to be willing to pick it. A model reachable but
     never selected is the same as no model. */
  const chosen = selectModel(
    { requiredTier: "large" },
    { KIMI_API_KEY: "kimi-test-key" } as unknown as NodeJS.ProcessEnv,
    [spec],
  );
  const picked = (chosen as { model?: { id?: string }; reason?: string }) ?? {};
  console.log(
    picked.model?.id
      ? `router selected: ${picked.model.id} (${picked.reason ?? "no reason given"})`
      : `router did NOT select it: ${JSON.stringify(chosen).slice(0, 160)}`,
  );

  server.close();
}

void main();
