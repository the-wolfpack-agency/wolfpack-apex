/**
 * github-client tests — verifies our GitHub API wrapper sends the right
 * HTTP shape and refuses to call without a token. Uses an injected fetch
 * stub so no network is touched.
 */

import {
  createRepoFromTemplate,
  putFile,
  triggerWorkflow,
  type GithubClient,
} from "@/lib/github-client";

function makeClient(responses: Array<{ status?: number; json?: unknown; text?: string }>): {
  client: GithubClient;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchStub = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[i++] ?? { status: 200, json: {} };
    return Promise.resolve({
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { client: { token: "ghp_test", fetch: fetchStub }, calls };
}

describe("github-client", () => {
  it("refuses to call when token is empty", async () => {
    const { client } = makeClient([]);
    const empty: GithubClient = { ...client, token: "" };
    await expect(
      createRepoFromTemplate(empty, "the-wolfpack-agency", "wolfpack-site-template", "the-wolfpack-agency", "x"),
    ).rejects.toThrow(/GITHUB_TOKEN_WOLFPACK_AGENCY/);
  });

  it("createRepoFromTemplate POSTs to the generate endpoint with the right body", async () => {
    const { client, calls } = makeClient([
      { status: 201, json: { full_name: "the-wolfpack-agency/wolfpack-x", html_url: "https://github.com/the-wolfpack-agency/wolfpack-x" } },
    ]);
    const out = await createRepoFromTemplate(
      client,
      "the-wolfpack-agency",
      "wolfpack-site-template",
      "the-wolfpack-agency",
      "wolfpack-x",
    );
    expect(out.full_name).toBe("the-wolfpack-agency/wolfpack-x");
    expect(calls[0].url).toBe("https://api.github.com/repos/the-wolfpack-agency/wolfpack-site-template/generate");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ owner: "the-wolfpack-agency", name: "wolfpack-x", private: true });
  });

  it("putFile fetches existing sha then PUTs base64 content", async () => {
    const { client, calls } = makeClient([
      { status: 200, json: { sha: "abc123" } }, // GET existing
      { status: 200, json: {} },                 // PUT
    ]);
    await putFile(client, "the-wolfpack-agency/wolfpack-x", "briefs/x.json", "{\"client\":\"x\"}", "msg");
    expect(calls).toHaveLength(2);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[1].init.method).toBe("PUT");
    const putBody = JSON.parse(calls[1].init.body as string);
    expect(putBody.sha).toBe("abc123");
    expect(Buffer.from(putBody.content, "base64").toString("utf-8")).toBe('{"client":"x"}');
  });

  it("putFile creates a new file when GET returns 404", async () => {
    const { client, calls } = makeClient([
      { status: 404, text: "not found" },
      { status: 201, json: {} },
    ]);
    await putFile(client, "the-wolfpack-agency/wolfpack-x", "briefs/y.json", "{}", "msg");
    expect(calls).toHaveLength(2);
    const putBody = JSON.parse(calls[1].init.body as string);
    expect(putBody.sha).toBeUndefined();
  });

  it("triggerWorkflow POSTs to the dispatch endpoint with ref", async () => {
    const { client, calls } = makeClient([{ status: 204 }]);
    await triggerWorkflow(client, "the-wolfpack-agency/wolfpack-x", "canary-deploy.yml", "main");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/the-wolfpack-agency/wolfpack-x/actions/workflows/canary-deploy.yml/dispatches",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ref: "main" });
  });

  it("surfaces github errors with status code", async () => {
    const { client } = makeClient([{ status: 422, text: "name already exists" }]);
    await expect(
      createRepoFromTemplate(client, "o", "t", "o", "n"),
    ).rejects.toThrow(/422.*name already exists/);
  });
});
