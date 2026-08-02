/**
 * Proving a model answers, rather than that someone set a variable.
 *
 * The availability list cannot tell a working deployment from a typo, a deleted
 * deployment or a rotated key — all four render identically as green. These
 * tests are mostly about turning each of those into a sentence an operator can
 * act on.
 */
import { endpointShape, explainStatus, probeAllModels, probeModel, probeTargetFor } from "../probe";
import { MODEL_REGISTRY } from "../registry";
import { fakeFetch } from "@/lib/platform-scan/__tests__/fake-fetch";

const CLASSIC = {
  AZURE_OPENAI_ENDPOINT: "https://acme.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_DEPLOYMENT_CHEAP: "my-mini",
} as unknown as NodeJS.ProcessEnv;

const FOUNDRY = {
  AZURE_AI_FOUNDRY_ENDPOINT: "https://acme.services.ai.azure.com/models",
  AZURE_AI_FOUNDRY_API_KEY: "k",
  AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK: "deepseek-v3",
} as unknown as NodeJS.ProcessEnv;

const spec = (id: string) => MODEL_REGISTRY.find((m) => m.id === id)!;

describe("it probes the URL the provider would really use", () => {
  it("puts the deployment in the URL for a classic endpoint", () => {
    const target = probeTargetFor(spec("azure-gpt-4o-mini"), CLASSIC)!;
    expect(target.url).toContain("/openai/deployments/my-mini/chat/completions");
    // Classic encodes the deployment in the URL, so repeating it in the body
    // is what produces a confusing 400 rather than a clean answer.
    expect(target.body.model).toBeUndefined();
  });

  it("puts the deployment in the BODY for a Foundry endpoint", () => {
    const target = probeTargetFor(spec("azure-deepseek-v3"), FOUNDRY)!;
    expect(target.url).toContain("/models/chat/completions");
    expect(target.body.model).toBe("deepseek-v3");
  });

  it("appends /models when the Foundry endpoint omits it", () => {
    const env = { ...FOUNDRY, AZURE_AI_FOUNDRY_ENDPOINT: "https://acme.services.ai.azure.com" } as unknown as NodeJS.ProcessEnv;
    expect(probeTargetFor(spec("azure-deepseek-v3"), env)!.url).toContain("/models/chat/completions");
  });

  it("sends the smallest thing that proves the path", () => {
    // A reachability check has no business carrying data. A probe that leaked
    // workspace context would be a worse bug than the one it detects.
    const target = probeTargetFor(spec("azure-gpt-4o-mini"), CLASSIC)!;
    expect(target.body.max_tokens).toBe(1);
    // Asserted as an exact key set rather than by searching the JSON for
    // suspicious words: the first version matched on /user/ and tripped over
    // OpenAI's own "role":"user", flagging a correct body. The property that
    // matters is that NOTHING beyond the minimum is sent, and a key set says
    // that precisely.
    expect(Object.keys(target.body).sort()).toEqual(["max_tokens", "messages"]);
    expect(target.body.messages).toEqual([{ role: "user", content: "ping" }]);
  });
});

describe("Foundry is decided on the host, not on a substring", () => {
  // CodeQL flagged the first version as a missing regexp anchor, and it was
  // right: /\.services\.ai\.azure\.com/ against the whole endpoint matches
  // anywhere in it. Here it only picks the wrong request shape, but a substring
  // test against a URL is the pattern that becomes an SSRF the moment it is
  // copied somewhere that decides trust.
  it.each([
    ["https://acme.services.ai.azure.com", "foundry"],
    ["https://services.ai.azure.com", "foundry"],
    ["https://acme.openai.azure.com", "classic"],
  ])("%s is %s", (endpoint, expected) => {
    expect(endpointShape(endpoint)).toBe(expected);
  });

  it.each([
    "https://attacker.example/?x=.services.ai.azure.com",
    "https://attacker.example/.services.ai.azure.com",
    "https://services.ai.azure.com.attacker.example",
    "https://notservices.ai.azure.com",
  ])("does not read Foundry out of %s", (endpoint) => {
    expect(endpointShape(endpoint)).toBe("classic");
  });

  it("refuses anything that is not a parseable https URL", () => {
    // Reported as not-configured rather than probed on a guess.
    expect(endpointShape("not a url")).toBeNull();
    expect(endpointShape("http://acme.openai.azure.com")).toBeNull();
  });

  it("still honours an explicit /models path on an ordinary host", () => {
    // A self-hosted Foundry-compatible gateway is a real deployment, and the
    // path is the signal there. Read from the PATHNAME, so a query string
    // cannot fake it.
    expect(endpointShape("https://gw.internal.example/models")).toBe("foundry");
    expect(endpointShape("https://gw.internal.example/?a=/models")).toBe("classic");
  });
});

describe("a failure becomes something an operator can act on", () => {
  it("names the real cause of a 404", () => {
    // The single most common misconfiguration, and the message says which of
    // the two similar-looking names to check.
    expect(explainStatus(404, "azure-deepseek-v3")).toMatch(/deployment name, not the model name/);
  });

  it.each([
    [401, /key was rejected/],
    [403, /key was rejected/],
    [500, /server error/],
  ])("explains %s", (status, pattern) => {
    expect(explainStatus(status, "x")).toMatch(pattern);
  });

  it("treats 429 as PROOF the model exists", () => {
    // Reporting a rate limit as unreachable would send someone hunting a
    // deployment name that is perfectly correct.
    expect(explainStatus(429, "x")).toMatch(/exists and is reachable/);
  });
});

describe("probeModel", () => {
  it("reports reachable when the endpoint answers", async () => {
    const result = await probeModel(spec("azure-gpt-4o-mini"), {
      env: CLASSIC,
      fetchImpl: fakeFetch({ status: 200, body: "{}" }),
    });
    expect(result.outcome).toBe("reachable");
    expect(result.latencyMs).not.toBeNull();
  });

  it("reports a 404 as UNREACHABLE even though it is configured", async () => {
    // The whole point. This is the model the availability list shows as green.
    const result = await probeModel(spec("azure-gpt-4o-mini"), {
      env: CLASSIC,
      fetchImpl: fakeFetch({ status: 404, body: "{}" }),
    });
    expect(result.outcome).toBe("unreachable");
    expect(result.detail).toMatch(/deployment name/);
  });

  it("reports a rate limit as REACHABLE, with the reason", async () => {
    const result = await probeModel(spec("azure-gpt-4o-mini"), {
      env: CLASSIC,
      fetchImpl: fakeFetch({ status: 429, body: "{}" }),
    });
    expect(result.outcome).toBe("reachable");
    expect(result.detail).toMatch(/quota is exhausted/);
  });

  it("does not probe a model that is not configured", async () => {
    const f = fakeFetch({ status: 200, body: "{}" });
    const result = await probeModel(spec("azure-deepseek-v3"), { env: CLASSIC, fetchImpl: f });
    expect(result.outcome).toBe("not-configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("never echoes the response body, which can carry a key back", async () => {
    const result = await probeModel(spec("azure-gpt-4o-mini"), {
      env: CLASSIC,
      fetchImpl: fakeFetch({ status: 403, body: '{"error":"key sk-secret-12345 is invalid"}' }),
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret-12345");
  });

  it("reports a timeout rather than hanging a dashboard", async () => {
    const result = await probeModel(spec("azure-gpt-4o-mini"), {
      env: CLASSIC,
      fetchImpl: fakeFetch([], { hang: true }),
      timeoutMs: 20,
    });
    expect(result.outcome).toBe("unreachable");
    expect(result.detail).toMatch(/timed out/);
  });

  it("answers to the SAME egress guard as everything else", async () => {
    // The one thing that reaches every configured endpoint must not be the one
    // thing nobody checks.
    const env = { ...CLASSIC, AZURE_OPENAI_ENDPOINT: "https://evil.example.net" } as unknown as NodeJS.ProcessEnv;
    const f = fakeFetch({ status: 200, body: "{}" });
    const result = await probeModel(spec("azure-gpt-4o-mini"), { env, fetchImpl: f });
    expect(result.outcome).toBe("refused");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("the report leads with what is broken", () => {
  it("names models that are configured but not answering", async () => {
    const report = await probeAllModels({ env: CLASSIC, fetchImpl: fakeFetch({ status: 404, body: "{}" }) });
    expect(report.brokenlyConfigured).toContain("azure-gpt-4o-mini");
    expect(report.headline).toMatch(/availability list shows these as ready; they are not/);
  });

  it("does not blame the models when nothing is configured", async () => {
    const report = await probeAllModels({
      env: {} as unknown as NodeJS.ProcessEnv,
      fetchImpl: fakeFetch({ status: 200, body: "{}" }),
    });
    expect(report.brokenlyConfigured).toEqual([]);
    expect(report.headline).toMatch(/statement about configuration, not about the models/);
  });

  it("confirms when every configured model answers", async () => {
    const report = await probeAllModels({ env: CLASSIC, fetchImpl: fakeFetch({ status: 200, body: "{}" }) });
    expect(report.headline).toMatch(/Every configured model is reachable/);
  });
});
