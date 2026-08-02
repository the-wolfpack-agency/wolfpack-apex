/**
 * The allowlist enforcing rather than merely deciding.
 *
 * allowlist.ts could answer "is this host permitted". Nothing asked it, which
 * made it a library described as a control. These tests cover the wiring that
 * makes the description true, and the two properties that decide whether it is
 * worth having: it refuses what it should, and it does NOT refuse the hosts the
 * product actually calls.
 *
 * The second half matters as much as the first. A guard that blocks everything
 * passes every "did it refuse" test and takes production down.
 */
import { guardedFetch, urlFromFetchInput, EgressBlockedError } from "../guarded-fetch";

const ok = new Response("{}", { status: 200 });
const impl = jest.fn(async () => ok) as unknown as typeof fetch;
const record = jest.fn();

beforeEach(() => {
  (impl as unknown as jest.Mock).mockClear();
  record.mockClear();
});

describe("urlFromFetchInput", () => {
  it("reads a string, a URL and a Request without consuming a body", () => {
    expect(urlFromFetchInput("https://a.test/x")).toBe("https://a.test/x");
    expect(urlFromFetchInput(new URL("https://a.test/y"))).toBe("https://a.test/y");
    const req = new Request("https://a.test/z", { method: "POST", body: "payload" });
    expect(urlFromFetchInput(req)).toBe("https://a.test/z");
    // The body is still readable, i.e. we did not consume the stream to look
    // at the URL — that would break the very request we are guarding.
    expect(req.bodyUsed).toBe(false);
  });
});

describe("the hosts the product really calls are allowed", () => {
  it("permits the Anthropic API", async () => {
    await guardedFetch("model-api", { fetchImpl: impl, record })("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("permits an Azure OpenAI resource, which is a per-tenant subdomain", async () => {
    // Real endpoints look like <resource>.openai.azure.com. If the dot-boundary
    // match were wrong this would refuse every model call in production.
    await guardedFetch("model-api", { fetchImpl: impl, record })(
      "https://homyk-mohqi52o-eastus2.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21",
    );
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("permits an Azure Cognitive Services endpoint", async () => {
    await guardedFetch("model-api", { fetchImpl: impl, record })("https://x.cognitiveservices.azure.com/openai/v1/responses");
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe("what it refuses", () => {
  const call = (url: string) => guardedFetch("model-api", { fetchImpl: impl, record })(url);

  it("throws rather than returning a failed response", async () => {
    // A provider that gets a 4xx retries or degrades. A provider that gets a
    // throw stops. Refusing a host and then retrying it three times is not a
    // boundary.
    await expect(call("https://huggingface.co/api/models")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses a host belonging to a different capability", async () => {
    // The model API has no business reaching source control.
    await expect(call("https://api.github.com/repos")).rejects.toThrow(/egress refused/);
  });

  it("refuses plain http even to an allowed host", async () => {
    await expect(call("http://api.anthropic.com/v1/messages")).rejects.toThrow(/https/);
  });

  it("refuses a lookalike domain", async () => {
    await expect(call("https://api.anthropic.com.evil.test/v1")).rejects.toThrow(/egress refused/);
    await expect(call("https://evil-openai.azure.com.attacker.test/x")).rejects.toThrow(/egress refused/);
  });

  it("refuses the cloud metadata endpoint, the highest-value target for an escape", async () => {
    await expect(call("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });

  it("carries the host and capability on the error, so the refusal is diagnosable", async () => {
    try {
      await call("https://mystery.test/x");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EgressBlockedError);
      expect((err as EgressBlockedError).host).toBe("mystery.test");
      expect((err as EgressBlockedError).capability).toBe("model-api");
    }
  });
});

describe("refusals are recorded", () => {
  it("records BEFORE throwing, so a blocked call is visible afterwards", async () => {
    // A refusal nobody can see later is the state both 2026 incidents were in
    // while they were happening.
    await expect(guardedFetch("model-api", { fetchImpl: impl, record })("https://mystery.test/x")).rejects.toThrow();
    expect(record).toHaveBeenCalledWith("mystery.test", "model-api", expect.stringContaining("not on the model-api allowlist"));
  });

  it("records something usable even when the URL will not parse", async () => {
    await expect(guardedFetch("model-api", { fetchImpl: impl, record })("not a url")).rejects.toThrow();
    expect(record).toHaveBeenCalledWith(expect.stringContaining("not a url"), "model-api", expect.any(String));
  });
});

describe("per-run hosts", () => {
  it("permits a host cleared for this run only", async () => {
    await guardedFetch("target-scan", { fetchImpl: impl, record, extraHosts: ["client.test"] })("https://client.test/");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("does not leak that permission to another guard", async () => {
    // extraHosts is a parameter, not module state: one run cannot widen the
    // allowlist for the next.
    await expect(guardedFetch("target-scan", { fetchImpl: impl, record })("https://client.test/")).rejects.toThrow();
  });
});
