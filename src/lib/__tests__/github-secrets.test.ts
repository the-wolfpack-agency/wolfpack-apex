/**
 * github-secrets tests — exercises the two-step seal-and-PUT flow with an
 * injected fetch stub and a fake libsodium (via __setSodiumForTests) so the
 * assertions are deterministic without needing the real WASM module. Mirrors
 * the sites-github.test.ts + vercel-client.test.ts pattern already in use.
 *
 * Assertions:
 *   - GET public-key request shape (URL, auth, User-Agent).
 *   - returned key_id + base64 key are parsed correctly.
 *   - PUT request's `encrypted_value` is valid base64 whose decoded length
 *     equals crypto_box_SEALBYTES + message length — i.e. exactly the right
 *     number of bytes went over the wire. No private key needed in test.
 *   - 404 on public-key GET → typed GithubSecretError with status + repo.
 *   - 403 on PUT → typed GithubSecretError naming repo + secret.
 */

import {
  GithubSecretError,
  __setSodiumForTests,
  setRepoSecret,
  type SodiumLike,
} from "@/lib/github-secrets";
import type { GithubClient } from "@/lib/github-client";

/**
 * Fake sodium impl: crypto_box_seal returns `<SEALBYTES zero prefix><msg bytes>`
 * so the test can cheaply assert the byte-length contract without a real
 * asymmetric crypto runtime. Returns base64 when outputFormat="base64" is
 * requested (the only call shape setRepoSecret uses).
 */
const FAKE_SEALBYTES = 48;

function fakeSodium(): SodiumLike {
  return {
    ready: Promise.resolve(),
    crypto_box_SEALBYTES: FAKE_SEALBYTES,
    crypto_box_seal(
      message: Uint8Array | string,
      _publicKey: Uint8Array,
      outputFormat?: "uint8array" | "base64",
    ): Uint8Array | string {
      const msgBytes =
        typeof message === "string" ? Buffer.from(message, "utf-8") : Buffer.from(message);
      const sealed = Buffer.concat([Buffer.alloc(FAKE_SEALBYTES, 0), msgBytes]);
      if (outputFormat === "base64") return sealed.toString("base64");
      return new Uint8Array(sealed);
    },
    from_base64(input: string): Uint8Array {
      return new Uint8Array(Buffer.from(input, "base64"));
    },
    to_base64(bytes: Uint8Array): string {
      return Buffer.from(bytes).toString("base64");
    },
    base64_variants: { ORIGINAL: 1 },
  };
}

function makeClient(responses: Array<{ status?: number; json?: unknown; text?: string }>): {
  client: GithubClient;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchStub = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[i++] ?? { status: 200, json: {} };
    const status = r.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { client: { token: "ghp_test", fetch: fetchStub }, calls };
}

describe("github-secrets / setRepoSecret", () => {
  beforeEach(() => {
    __setSodiumForTests(fakeSodium());
  });
  afterAll(() => {
    __setSodiumForTests(null);
  });

  it("refuses to call when token is empty", async () => {
    const { client } = makeClient([]);
    const empty: GithubClient = { ...client, token: "" };
    await expect(
      setRepoSecret(empty, "the-wolfpack-agency/wolfpack-x", "VERCEL_TOKEN", "v"),
    ).rejects.toThrow(/GITHUB_TOKEN_WOLFPACK_AGENCY/);
  });

  it("GETs /actions/secrets/public-key with bearer + user-agent", async () => {
    const pubKeyBase64 = Buffer.alloc(32, 7).toString("base64");
    const { client, calls } = makeClient([
      { status: 200, json: { key_id: "kid_1", key: pubKeyBase64 } },
      { status: 204 },
    ]);
    await setRepoSecret(client, "the-wolfpack-agency/wolfpack-x", "VERCEL_TOKEN", "tkn");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/the-wolfpack-agency/wolfpack-x/actions/secrets/public-key",
    );
    expect(calls[0].init.method).toBe("GET");
    const getHeaders = calls[0].init.headers as Record<string, string>;
    expect(getHeaders["Authorization"]).toBe("Bearer ghp_test");
    expect(getHeaders["User-Agent"]).toBe("wolfpack-instinct-sites");
    expect(getHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("PUTs encrypted_value + key_id to /actions/secrets/{name} and resolves ok on 201", async () => {
    const pubKeyBase64 = Buffer.alloc(32, 7).toString("base64");
    const secretValue = "s3cr3t-token-value";
    const { client, calls } = makeClient([
      { status: 200, json: { key_id: "kid_1", key: pubKeyBase64 } },
      { status: 201 },
    ]);
    const out = await setRepoSecret(
      client,
      "the-wolfpack-agency/wolfpack-x",
      "VERCEL_TOKEN",
      secretValue,
    );
    expect(out).toEqual({ ok: true });
    expect(calls[1].url).toBe(
      "https://api.github.com/repos/the-wolfpack-agency/wolfpack-x/actions/secrets/VERCEL_TOKEN",
    );
    expect(calls[1].init.method).toBe("PUT");
    const body = JSON.parse(calls[1].init.body as string);
    expect(body.key_id).toBe("kid_1");
    expect(typeof body.encrypted_value).toBe("string");

    // Decoded length must be crypto_box_SEALBYTES + message-byte length.
    // Proves the right number of bytes crossed the wire without needing a
    // private key to actually decrypt in the test.
    const decoded = Buffer.from(body.encrypted_value, "base64");
    const expectedLen = FAKE_SEALBYTES + Buffer.from(secretValue, "utf-8").length;
    expect(decoded.length).toBe(expectedLen);
    // valid base64 round-trip (throws in Buffer.from would be silent — this
    // re-encode asserts we didn't send padding garbage either).
    expect(decoded.toString("base64")).toBe(body.encrypted_value);
  });

  it("URL-encodes the secret name segment", async () => {
    const pubKeyBase64 = Buffer.alloc(32, 3).toString("base64");
    const { client, calls } = makeClient([
      { status: 200, json: { key_id: "kid_1", key: pubKeyBase64 } },
      { status: 204 },
    ]);
    // GitHub secret names are alphanumeric + underscore in practice, but
    // the helper encodes defensively — assert it doesn't double-encode a
    // normal name.
    await setRepoSecret(client, "o/r", "INSTINCT_WEBHOOK_URL", "v");
    expect(calls[1].url).toBe(
      "https://api.github.com/repos/o/r/actions/secrets/INSTINCT_WEBHOOK_URL",
    );
  });

  it("treats 204 as success (idempotent overwrite)", async () => {
    const pubKeyBase64 = Buffer.alloc(32, 5).toString("base64");
    const { client } = makeClient([
      { status: 200, json: { key_id: "kid_1", key: pubKeyBase64 } },
      { status: 204 },
    ]);
    const out = await setRepoSecret(client, "o/r", "X", "v");
    expect(out).toEqual({ ok: true });
  });

  it("throws GithubSecretError with status + repo on 404 public-key GET", async () => {
    const { client } = makeClient([{ status: 404, text: "not found" }]);
    try {
      await setRepoSecret(client, "the-wolfpack-agency/wolfpack-missing", "VERCEL_TOKEN", "v");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubSecretError);
      expect((err as GithubSecretError).status).toBe(404);
      expect((err as GithubSecretError).repo).toBe("the-wolfpack-agency/wolfpack-missing");
      expect((err as Error).message).toMatch(/404/);
      expect((err as Error).message).toMatch(/wolfpack-missing/);
    }
  });

  it("throws GithubSecretError naming the repo + secret on 403 PUT", async () => {
    const pubKeyBase64 = Buffer.alloc(32, 1).toString("base64");
    const { client } = makeClient([
      { status: 200, json: { key_id: "kid_1", key: pubKeyBase64 } },
      { status: 403, text: "forbidden — secrets:write scope missing" },
    ]);
    try {
      await setRepoSecret(client, "the-wolfpack-agency/wolfpack-x", "VERCEL_TOKEN", "v");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubSecretError);
      expect((err as GithubSecretError).status).toBe(403);
      expect((err as GithubSecretError).repo).toBe("the-wolfpack-agency/wolfpack-x");
      expect((err as GithubSecretError).secretName).toBe("VERCEL_TOKEN");
      expect((err as Error).message).toMatch(/403/);
      expect((err as Error).message).toMatch(/wolfpack-x/);
      expect((err as Error).message).toMatch(/VERCEL_TOKEN/);
    }
  });

  it("throws when the public-key response is malformed (no key_id/key)", async () => {
    const { client } = makeClient([{ status: 200, json: { nope: true } }]);
    await expect(
      setRepoSecret(client, "o/r", "X", "v"),
    ).rejects.toThrow(/public-key response malformed/);
  });
});
