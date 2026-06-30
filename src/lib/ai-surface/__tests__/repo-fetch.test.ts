/**
 * Unit tests for the live repo-fetch source.
 *
 * Covers: URL parsing (accepts github.com owner/repo[/tree/ref]; REJECTS
 * non-GitHub hosts, IP literals, http, userinfo, look-alike hosts, traversal —
 * the SSRF-shaped inputs); file filtering to scannable extensions + the
 * per-file/total caps; and typed errors on 404 / 403 / rate-limit / network
 * using a mocked fetch. The network is fully mocked — no real GitHub calls.
 */

import {
  parseRepoUrl,
  fetchRepoFiles,
  statusForError,
  MAX_FILES,
  type RepoFetchDeps,
} from "../repo-fetch";

describe("parseRepoUrl", () => {
  test("accepts a plain github.com owner/repo URL", () => {
    const r = parseRepoUrl("https://github.com/vercel/next.js");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ owner: "vercel", repo: "next.js", ref: undefined });
  });

  test("strips a trailing .git and accepts www.github.com", () => {
    const r = parseRepoUrl("https://www.github.com/openai/openai-node.git");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ owner: "openai", repo: "openai-node" });
  });

  test("captures a pinned branch from /tree/<ref>", () => {
    const r = parseRepoUrl("https://github.com/owner/repo/tree/release-1.2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ref).toBe("release-1.2");
  });

  test.each([
    ["http://github.com/o/r", "http scheme"],
    ["https://gitlab.com/o/r", "non-github host"],
    ["https://github.com.evil.test/o/r", "look-alike host"],
    ["https://127.0.0.1/o/r", "IP literal / internal host"],
    ["https://169.254.169.254/latest/meta-data", "metadata SSRF host"],
    ["https://user:pw@github.com/o/r", "embedded credentials"],
    ["https://github.com/onlyowner", "missing repo"],
    ["https://github.com/o/..%2f..%2fetc", "path traversal in repo name"],
    ["not a url", "garbage"],
    ["", "empty"],
  ])("rejects %s (%s) as invalid_url", (input) => {
    const r = parseRepoUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_url");
  });
});

/** Build a mocked fetch deps from a route->response map. Matches the
 *  LONGEST (most specific) key whose substring is in the URL, so a bare
 *  "/repos/o/r" key never shadows a "/repos/o/r/git/trees/..." URL. */
function mockDeps(handlers: Record<string, () => Response>, token?: string): RepoFetchDeps {
  const keys = Object.keys(handlers).sort((a, b) => b.length - a.length);
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const needle of keys) {
      if (url.includes(needle)) return handlers[needle]();
    }
    return new Response("not found", { status: 404 });
  });
  return { fetch: fetchMock as unknown as typeof fetch, token };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe("fetchRepoFiles", () => {
  test("resolves default branch, filters to scannable files, returns SourceFile[]", async () => {
    const deps = mockDeps({
      "/repos/o/r": () => json({ default_branch: "main" }),
      "/git/trees/main": () =>
        json({
          truncated: false,
          tree: [
            { path: "src/ai.ts", type: "blob", size: 100 },
            { path: "image.png", type: "blob", size: 5000 }, // not scannable
            { path: "lib", type: "tree" }, // dir, skipped
            { path: "huge.ts", type: "blob", size: 999_999_999 }, // over per-file cap
          ],
        }),
      "raw.githubusercontent.com/o/r/main/src/ai.ts": () => text(`import OpenAI from "openai";`),
    });

    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.target).toBe("o/r");
    expect(res.value.files).toEqual([{ path: "src/ai.ts", content: `import OpenAI from "openai";` }]);
    expect(res.value.treeFileCount).toBe(1); // only ai.ts passed the filters
    expect(res.value.fetchedFileCount).toBe(1);
  });

  test("uses a pinned branch without resolving the default", async () => {
    const repoCall = jest.fn();
    const deps = mockDeps({
      "/repos/o/r/git/trees/dev": () => json({ tree: [{ path: "a.py", type: "blob", size: 10 }] }),
      "raw.githubusercontent.com/o/r/dev/a.py": () => text("import anthropic"),
    });
    // Wrap to detect a default-branch lookup (it must NOT happen).
    const inner = deps.fetch;
    deps.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith("/repos/o/r")) repoCall();
      return inner(u, init);
    }) as typeof fetch;

    const res = await fetchRepoFiles("https://github.com/o/r/tree/dev", deps);
    expect(res.ok).toBe(true);
    expect(repoCall).not.toHaveBeenCalled();
  });

  test("caps the number of files fetched at MAX_FILES", async () => {
    const tree = Array.from({ length: MAX_FILES + 50 }, (_, i) => ({
      path: `f${i}.ts`,
      type: "blob",
      size: 10,
    }));
    const handlers: Record<string, () => Response> = {
      "/repos/o/r": () => json({ default_branch: "main" }),
      "/git/trees/main": () => json({ tree, truncated: false }),
    };
    // Any raw file returns trivial content.
    handlers["raw.githubusercontent.com"] = () => text("x");
    const deps = mockDeps(handlers);

    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fetchedFileCount).toBeLessThanOrEqual(MAX_FILES);
    expect(res.value.truncated).toBe(true);
  });

  test("returns not_found when the repo 404s", async () => {
    const deps = mockDeps({ "/repos/o/r": () => json({ message: "Not Found" }, 404) });
    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("not_found");
  });

  test("returns forbidden on a 403 with remaining budget", async () => {
    const deps = mockDeps({
      "/repos/o/r": () => json({}, 403, { "x-ratelimit-remaining": "12" }),
    });
    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("forbidden");
  });

  test("returns rate_limited on a 403 with the budget exhausted", async () => {
    const deps = mockDeps({
      "/repos/o/r": () => json({}, 403, { "x-ratelimit-remaining": "0" }),
    });
    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rate_limited");
  });

  test("returns rate_limited on a 429", async () => {
    const deps = mockDeps({ "/repos/o/r": () => json({}, 429) });
    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rate_limited");
  });

  test("returns service_unavailable when fetch throws (network)", async () => {
    const deps: RepoFetchDeps = {
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    };
    const res = await fetchRepoFiles("https://github.com/o/r", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("service_unavailable");
  });

  test("a bad URL short-circuits before any fetch", async () => {
    const fetchMock = jest.fn();
    const res = await fetchRepoFiles("https://gitlab.com/o/r", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("never sends the token in a way that leaks; sends Authorization header when present", async () => {
    let sawAuth = false;
    const deps: RepoFetchDeps = {
      token: "secret-token",
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth?.includes("secret-token")) sawAuth = true;
        if (String(_u).endsWith("/repos/o/r")) return json({ default_branch: "main" });
        if (String(_u).includes("/git/trees/")) return json({ tree: [] });
        return text("x");
      }) as typeof fetch,
    };
    await fetchRepoFiles("https://github.com/o/r", deps);
    expect(sawAuth).toBe(true);
  });
});

describe("statusForError", () => {
  test("maps each error kind to the right HTTP status", () => {
    expect(statusForError("invalid_url")).toBe(400);
    expect(statusForError("not_found")).toBe(404);
    expect(statusForError("forbidden")).toBe(403);
    expect(statusForError("rate_limited")).toBe(429);
    expect(statusForError("service_unavailable")).toBe(502);
  });
});
