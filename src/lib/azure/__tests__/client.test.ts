/**
 * Shared Azure client tests. Pins:
 *   - Credential resolution prefers per-service env vars, falls back
 *     to multi-service, returns null when neither is set.
 *   - postAzure maps HTTP statuses to typed errors (401/403, 429, 400,
 *     5xx) and surfaces Operation-Location for async ops.
 *   - pollAzureOperation polls until succeeded / failed / max attempts.
 */

import {
  resolveAzureCreds,
  postAzure,
  pollAzureOperation,
} from "@/lib/azure/client";

describe("resolveAzureCreds", () => {
  const restore: Record<string, string | undefined> = {};
  const KEYS = [
    "AZURE_VISION_ENDPOINT",
    "AZURE_VISION_KEY",
    "AZURE_FORM_REC_ENDPOINT",
    "AZURE_FORM_REC_KEY",
    "AZURE_COGNITIVE_ENDPOINT",
    "AZURE_COGNITIVE_KEY",
  ];
  beforeEach(() => {
    for (const k of KEYS) {
      restore[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  it("returns null when nothing is configured", () => {
    expect(resolveAzureCreds("vision")).toBeNull();
    expect(resolveAzureCreds("form_recognizer")).toBeNull();
  });

  it("prefers per-service env vars", () => {
    process.env.AZURE_VISION_ENDPOINT = "https://vision.x.com/";
    process.env.AZURE_VISION_KEY = "vkey";
    process.env.AZURE_COGNITIVE_ENDPOINT = "https://multi.x.com/";
    process.env.AZURE_COGNITIVE_KEY = "mkey";
    const out = resolveAzureCreds("vision");
    expect(out).toEqual({ endpoint: "https://vision.x.com", key: "vkey" });
  });

  it("falls back to multi-service vars when per-service is missing", () => {
    process.env.AZURE_COGNITIVE_ENDPOINT = "https://multi.x.com/";
    process.env.AZURE_COGNITIVE_KEY = "mkey";
    const v = resolveAzureCreds("vision");
    const f = resolveAzureCreds("form_recognizer");
    expect(v).toEqual({ endpoint: "https://multi.x.com", key: "mkey" });
    expect(f).toEqual({ endpoint: "https://multi.x.com", key: "mkey" });
  });

  it("strips a trailing slash from endpoint", () => {
    process.env.AZURE_VISION_ENDPOINT = "https://vision.x.com////";
    process.env.AZURE_VISION_KEY = "vkey";
    expect(resolveAzureCreds("vision")?.endpoint).toBe("https://vision.x.com");
  });
});

const creds = { endpoint: "https://vision.x.com", key: "tk" };
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.resetAllMocks();
});

/** Real fetch sets `ok` for 2xx ONLY, never for a 3xx. These fakes said
 *  `status < 400`, so a redirect would have read as success. No test here
 *  currently uses a 3xx, so it was a trap rather than a live bug — corrected
 *  alongside the same mistake found in the compliance collector (PR #224). */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function mockFetchOnce(opts: {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  throws?: Error;
}) {
  global.fetch = jest.fn(async () => {
    if (opts.throws) throw opts.throws;
    return {
      ok: opts.ok ?? isOk(opts.status ?? 200),
      status: opts.status ?? 200,
      headers: new Headers(opts.headers ?? {}),
      json: async () => opts.body ?? {},
      text: async () => opts.text ?? "",
    } as unknown as Response;
  }) as jest.Mock;
}

describe("postAzure error mapping", () => {
  it("maps 401/403 to forbidden", async () => {
    mockFetchOnce({ status: 403 });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  it("maps 429 to rate_limited with retryAfter from headers", async () => {
    mockFetchOnce({ status: 429, headers: { "retry-after": "42" }, text: "throttled" });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "rate_limited") expect(r.error.retryAfter).toBe(42);
  });

  it("maps 400 to bad_request with truncated detail", async () => {
    mockFetchOnce({ status: 400, text: "x".repeat(1000) });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("bad_request");
      expect(r.error.detail.length).toBeLessThanOrEqual(420);
    }
  });

  it("returns operationLocation on success", async () => {
    mockFetchOnce({ status: 202, headers: { "operation-location": "https://x.com/ops/123" } });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.operationLocation).toBe("https://x.com/ops/123");
  });

  it("returns internal when 202 lacks Operation-Location", async () => {
    mockFetchOnce({ status: 202 });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("internal");
  });

  it("classifies network errors as graph_unavailable", async () => {
    mockFetchOnce({ throws: new Error("ECONNREFUSED") });
    const r = await postAzure(creds, "x/y", { body: Buffer.from("hi"), contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("graph_unavailable");
  });
});

describe("pollAzureOperation", () => {
  it("returns succeeded body", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "succeeded", payload: { text: "ok" } }),
      text: async () => "",
    } as unknown as Response)) as jest.Mock;
    const r = await pollAzureOperation<{ payload: { text: string } }>(creds, "https://x.com/ops", { intervalMs: 1, maxAttempts: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.payload.text).toBe("ok");
  });

  it("returns internal when status=failed", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "failed" }),
      text: async () => "",
    } as unknown as Response)) as jest.Mock;
    const r = await pollAzureOperation(creds, "https://x.com/ops", { intervalMs: 1, maxAttempts: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("internal");
  });

  it("returns polling_timeout when max attempts elapse with running status", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "running" }),
      text: async () => "",
    } as unknown as Response)) as jest.Mock;
    const r = await pollAzureOperation(creds, "https://x.com/ops", { intervalMs: 1, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("polling_timeout");
  });
});
