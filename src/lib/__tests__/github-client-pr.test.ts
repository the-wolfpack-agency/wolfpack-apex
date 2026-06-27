/**
 * github-client PR-flow tests. Exercises the createBranch -> putFile -> openPullRequest
 * triad used by the remediation flow, using a routed fetch stub so no network is
 * touched. Asserts the exact HTTP shape: default-branch lookup, base-ref lookup,
 * ref creation body, the 422-swallow on a pre-existing branch, the contents GET
 * scoped to a branch, the PUT body carrying the branch, and the pulls POST body.
 */
import {
  createBranch,
  putFile,
  openPullRequest,
  type GithubClient,
} from "@/lib/github-client";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Route a request by (method, url) to a Response-like object. `overrides` lets a
 * single test change one route (e.g. make POST git/refs return 422).
 */
function makeClient(overrides?: {
  refsStatus?: number;
  refsText?: string;
}): { client: GithubClient; calls: Call[] } {
  const calls: Call[] = [];
  const reply = (status: number, obj: unknown, text = "") =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
      text: async () => text,
    } as unknown as Response);

  const fetchStub = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });

    if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return reply(200, { default_branch: "main" });
    }
    if (method === "GET" && url.includes("/git/ref/heads/")) {
      return reply(200, { object: { sha: "basesha" } });
    }
    if (method === "POST" && url.endsWith("/git/refs")) {
      const status = overrides?.refsStatus ?? 201;
      return reply(status, {}, overrides?.refsText ?? "");
    }
    if (method === "GET" && url.includes("/contents/")) {
      return reply(404, {}, "Not Found");
    }
    if (method === "PUT" && url.includes("/contents/")) {
      return reply(200, {});
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      return reply(201, { html_url: "https://github.com/o/r/pull/7", number: 7 });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;

  return { client: { token: "ghp_test", fetch: fetchStub }, calls };
}

describe("github-client PR flow", () => {
  it("createBranch looks up the default branch + base ref, then POSTs git/refs with the new ref and base sha", async () => {
    const { client, calls } = makeClient();
    await createBranch(client, "o/r", "ogiam/remediate-x");

    const repoGet = calls.find((c) => c.method === "GET" && /\/repos\/o\/r$/.test(c.url));
    const refGet = calls.find((c) => c.method === "GET" && c.url.includes("/git/ref/heads/main"));
    const refsPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"));

    expect(repoGet).toBeDefined();
    expect(refGet).toBeDefined();
    expect(refsPost).toBeDefined();
    expect(refsPost!.body).toEqual({ ref: "refs/heads/ogiam/remediate-x", sha: "basesha" });
  });

  it("createBranch uses an explicit fromBranch and does NOT look up the default branch", async () => {
    const { client, calls } = makeClient();
    await createBranch(client, "o/r", "ogiam/remediate-x", "main");

    const repoGet = calls.find((c) => c.method === "GET" && /\/repos\/o\/r$/.test(c.url));
    expect(repoGet).toBeUndefined();
    const refGet = calls.find((c) => c.url.includes("/git/ref/heads/main"));
    expect(refGet).toBeDefined();
  });

  it("createBranch swallows a 422 (ref already exists) and does NOT throw", async () => {
    const { client } = makeClient({ refsStatus: 422, refsText: "Reference already exists" });
    await expect(createBranch(client, "o/r", "ogiam/remediate-x", "main")).resolves.toBeUndefined();
  });

  it("createBranch rethrows a non-422 failure on git/refs", async () => {
    const { client } = makeClient({ refsStatus: 500, refsText: "boom" });
    await expect(createBranch(client, "o/r", "ogiam/remediate-x", "main")).rejects.toThrow(/500/);
  });

  it("putFile with a branch arg GETs contents with ?ref=<branch> and PUTs the branch in the body", async () => {
    const { client, calls } = makeClient();
    await putFile(client, "o/r", "docs/remediation/x.md", "hello", "msg", "feature-branch");

    const contentsGet = calls.find((c) => c.method === "GET" && c.url.includes("/contents/"));
    expect(contentsGet!.url).toContain("?ref=feature-branch");

    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/contents/"));
    expect(put).toBeDefined();
    expect(put!.body!.branch).toBe("feature-branch");
    expect(put!.body!.message).toBe("msg");
    // 404 on the contents GET means sha is undefined (create, not overwrite).
    expect(put!.body!.sha).toBeUndefined();
  });

  it("openPullRequest POSTs to /pulls with head/base/title/body and returns {html_url, number}", async () => {
    const { client, calls } = makeClient();
    const out = await openPullRequest(client, "o/r", "feature-branch", "main", "T", "B");

    expect(out).toEqual({ html_url: "https://github.com/o/r/pull/7", number: 7 });
    const pulls = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"));
    expect(pulls!.body).toEqual({ title: "T", head: "feature-branch", base: "main", body: "B" });
  });
});
