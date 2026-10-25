/**
 * github-client additions used by the Secure Agent PR gate:
 *   - installationGithubClient mints an installation token from the webhook's
 *     installation id (no workspace lookup), reusing the one token exchange, and
 *     never throws: no App config, a bad id, or a GitHub non-2xx yields token "".
 *   - fetchPostImages reads each changed file at the PR head, bounded and best
 *     effort (404, oversize and fetch errors are skipped, never thrown).
 * No network: fetch is a stub.
 */
import { generateKeyPairSync } from "node:crypto";
import { installationGithubClient, fetchPostImages, type GithubClient } from "@/lib/github-client";
import { __clearTokenCache } from "@/lib/github-app";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appConfig = { appId: "123", privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => __clearTokenCache());

describe("installationGithubClient", () => {
  it("exchanges the App JWT for the payload's installation token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(201, { token: "ghs_inst", expires_at: "2099-01-01T00:00:00Z" }));
    const c = await installationGithubClient("4242", { fetchImpl: fetchImpl as unknown as typeof fetch, appConfig });
    expect(c.token).toBe("ghs_inst");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/4242/access_tokens",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }) }),
    );
  });

  it("returns an empty token (never throws) without App config", async () => {
    const fetchImpl = jest.fn();
    const c = await installationGithubClient("4242", { fetchImpl: fetchImpl as unknown as typeof fetch, appConfig: null });
    expect(c.token).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric installation id without calling GitHub", async () => {
    const fetchImpl = jest.fn();
    const c = await installationGithubClient("../app", { fetchImpl: fetchImpl as unknown as typeof fetch, appConfig });
    expect(c.token).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns an empty token on a GitHub non-2xx or a network error", async () => {
    const notFound = jest.fn().mockResolvedValue(json(404, { message: "Not Found" }));
    expect((await installationGithubClient("1", { fetchImpl: notFound as unknown as typeof fetch, appConfig })).token).toBe("");
    const down = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect((await installationGithubClient("2", { fetchImpl: down as unknown as typeof fetch, appConfig })).token).toBe("");
  });
});

describe("fetchPostImages", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  function client(routes: Record<string, () => Response | Promise<Response>>): { c: GithubClient; urls: string[] } {
    const urls: string[] = [];
    const f = jest.fn(async (url: string) => {
      urls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return json(404, { message: "Not Found" });
      return hit[1]();
    });
    return { c: { token: "t", fetch: f as unknown as typeof fetch }, urls };
  }

  it("reads each path at the given ref and skips the ones it cannot read", async () => {
    const { c, urls } = client({
      "contents/src/a.ts": () => json(200, { type: "file", encoding: "base64", content: b64("export const a = 1;\n") }),
      "contents/src/boom.ts": () => {
        throw new Error("socket hang up");
      },
    });
    const out = await fetchPostImages(c, "acme/app", ["src/a.ts", "src/missing.ts", "src/boom.ts"], "abc123");
    expect(out).toEqual([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    expect(urls[0]).toContain("/repos/acme/app/contents/src/a.ts?ref=abc123");
  });

  it("is bounded by maxFiles and maxBytes", async () => {
    const { c, urls } = client({
      "contents/": () => json(200, { type: "file", encoding: "base64", content: b64("x".repeat(50)) }),
    });
    expect(await fetchPostImages(c, "acme/app", ["a", "b", "c"], "h", { maxFiles: 2 })).toHaveLength(2);
    expect(urls).toHaveLength(2);
    expect(await fetchPostImages(c, "acme/app", ["a"], "h", { maxBytes: 10 })).toEqual([]);
  });
});
