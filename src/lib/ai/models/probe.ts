/**
 * Does this model actually answer?
 *
 * THE GAP THIS CLOSES
 *
 * /admin/ai-router reports a model as "Available" when its environment
 * variables are non-empty. That is a statement about configuration, not about
 * reachability — a deployment name with a typo, a deleted deployment, a rotated
 * key and a working model all look identical.
 *
 * Someone reading that page sees green and concludes the model works. The first
 * evidence otherwise arrives as a 404 in production, on whichever feature
 * happened to route there. This is the difference between "someone set a
 * variable" and "this model answers".
 *
 * WHY IT IS EXPLICIT AND NOT AUTOMATIC
 *
 * A probe is a real inference call. It costs a fraction of a cent and it counts
 * against a rate limit, so it runs when an operator asks — after a deployment,
 * after a key rotation, before a client demo — and never on page load. A
 * dashboard that quietly bills you to render itself is a bad dashboard.
 *
 * WHAT IT SENDS
 *
 * The smallest thing that proves the path: a two-word prompt with a one-token
 * ceiling. It never sends anything about the workspace, a client, or a user,
 * because a reachability check has no business carrying data — and a probe that
 * leaked context would be a worse bug than the one it detects.
 */
import { MODEL_REGISTRY, isModelAvailable } from "./registry";
import { decideEgress } from "@/lib/containment/allowlist";
import type { ModelSpec } from "./types";

export type ProbeOutcome = "reachable" | "unreachable" | "not-configured" | "refused";

export interface ProbeResult {
  modelId: string;
  outcome: ProbeOutcome;
  /** Round trip in ms, when it answered. */
  latencyMs: number | null;
  /** HTTP status, when there was one. */
  status: number | null;
  /** What went wrong, in words an operator can act on. Never the raw body,
   *  which can echo a key. */
  detail: string | null;
}

export interface ProbeReport {
  results: ProbeResult[];
  reachable: number;
  /** Configured but NOT answering. The number that matters: these are the
   *  models a page would have shown as green. */
  brokenlyConfigured: string[];
  headline: string;
}

/** Where a probe for this model should be sent. Mirrors the provider's own
 *  detection so the probe tests the URL the provider would really use. */
export function probeTargetFor(spec: ModelSpec, env: NodeJS.ProcessEnv): { url: string; body: Record<string, unknown> } | null {
  const deployment = spec.deploymentEnvVar ? env[spec.deploymentEnvVar] : undefined;

  if (spec.provider === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      body: { model: spec.id, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }

  const endpoint = (env[spec.endpointEnvVar ?? "AZURE_OPENAI_ENDPOINT"] ?? "").replace(/\/+$/, "");
  if (!endpoint || !deployment) return null;

  const foundry = /\.services\.ai\.azure\.com/i.test(endpoint) || /\/models$/i.test(endpoint);
  if (foundry) {
    const base = /\/models$/i.test(endpoint) ? endpoint : `${endpoint}/models`;
    return {
      url: `${base}/chat/completions?api-version=2024-05-01-preview`,
      // Foundry's inference router takes the deployment in the BODY.
      body: { model: deployment, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  return {
    url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
    // Classic encodes the deployment in the URL, so the body must not repeat it.
    body: { max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
  };
}

/** Turn a failure into something an operator can act on, without echoing a body
 *  that may contain a key or a prompt. */
export function explainStatus(status: number, modelId: string): string {
  if (status === 404) {
    return `the deployment named for ${modelId} does not exist at that endpoint — check the deployment name, not the model name`;
  }
  if (status === 401 || status === 403) return "the key was rejected — it may be rotated, wrong, or for another resource";
  if (status === 429) return "rate limited — the model exists and is reachable, but the quota is exhausted";
  if (status >= 500) return "the provider returned a server error — the model may exist but is not serving right now";
  return `the provider refused with HTTP ${status}`;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function probeModel(spec: ModelSpec, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!isModelAvailable(spec, env)) {
    return { modelId: spec.id, outcome: "not-configured", latencyMs: null, status: null, detail: null };
  }
  const target = probeTargetFor(spec, env);
  if (!target) {
    return { modelId: spec.id, outcome: "not-configured", latencyMs: null, status: null, detail: "no endpoint could be built" };
  }

  // The same egress guard every other outbound call answers to. A probe is an
  // outbound request like any other, and exempting it would make the one thing
  // that reaches every configured endpoint the one thing nobody checks.
  const verdict = decideEgress(target.url, "model-api");
  if (verdict.allowed !== true) {
    return { modelId: spec.id, outcome: "refused", latencyMs: null, status: null, detail: `egress refused: ${verdict.reason}` };
  }

  const key = env[spec.apiKeyEnvVar ?? (spec.provider === "openai" ? "OPENAI_API_KEY" : "AZURE_OPENAI_API_KEY")] ?? "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (spec.provider === "openai") headers.authorization = `Bearer ${key}`;
  else headers["api-key"] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(target.body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    // 429 means the model is THERE. Reporting it as unreachable would send
    // someone hunting a deployment name that is perfectly correct.
    if (res.status === 429) {
      return { modelId: spec.id, outcome: "reachable", latencyMs, status: 429, detail: explainStatus(429, spec.id) };
    }
    if (!res.ok) {
      return { modelId: spec.id, outcome: "unreachable", latencyMs, status: res.status, detail: explainStatus(res.status, spec.id) };
    }
    return { modelId: spec.id, outcome: "reachable", latencyMs, status: res.status, detail: null };
  } catch (err) {
    const aborted = err instanceof Error && /abort/i.test(err.name + err.message);
    return {
      modelId: spec.id,
      outcome: "unreachable",
      latencyMs: Date.now() - startedAt,
      status: null,
      detail: aborted ? "timed out" : "the endpoint could not be reached",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAllModels(deps: ProbeDeps = {}): Promise<ProbeReport> {
  const results: ProbeResult[] = [];
  for (const spec of MODEL_REGISTRY) {
    results.push(await probeModel(spec, deps));
  }

  const reachable = results.filter((r) => r.outcome === "reachable").length;
  // The finding that matters: configured, shown as green, and not answering.
  const brokenlyConfigured = results.filter((r) => r.outcome === "unreachable" || r.outcome === "refused").map((r) => r.modelId);

  let headline: string;
  if (brokenlyConfigured.length > 0) {
    headline = `${brokenlyConfigured.length} model${brokenlyConfigured.length === 1 ? " is" : "s are"} configured but not answering: ${brokenlyConfigured.join(", ")}. The availability list shows these as ready; they are not.`;
  } else if (reachable === 0) {
    headline = "No model answered, because none is configured. This is a statement about configuration, not about the models.";
  } else {
    headline = `${reachable} model${reachable === 1 ? "" : "s"} answered. Every configured model is reachable.`;
  }

  return { results, reachable, brokenlyConfigured, headline };
}
