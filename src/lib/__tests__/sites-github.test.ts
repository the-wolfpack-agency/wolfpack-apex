/**
 * github-client tests — verifies our GitHub API wrapper sends the right
 * HTTP shape and refuses to call without a token. Uses an injected fetch
 * stub so no network is touched.
 */

import {
  createRepoFromTemplate,
  enableActions,
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

  // Regression: the 2026-04-17 workflow_dispatch was firing without the
  // deploy_id input, so the canary's "Notify Instinct" step hit its
  // early-exit branch and preview_url never propagated back to the
  // apex_site_deploys row.
  it("triggerWorkflow includes inputs in the dispatch body when provided", async () => {
    const { client, calls } = makeClient([{ status: 204 }]);
    await triggerWorkflow(
      client,
      "the-wolfpack-agency/wolfpack-x",
      "canary-deploy.yml",
      "main",
      { deploy_id: "deploy_abc" },
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      ref: "main",
      inputs: { deploy_id: "deploy_abc" },
    });
  });

  it("triggerWorkflow omits inputs key when no inputs passed", async () => {
    const { client, calls } = makeClient([{ status: 204 }]);
    await triggerWorkflow(client, "a/b", "x.yml", "main");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ ref: "main" });
    expect("inputs" in body).toBe(false);
  });

  it("surfaces github errors with status code", async () => {
    const { client } = makeClient([{ status: 422, text: "name already exists" }]);
    await expect(
      createRepoFromTemplate(client, "o", "t", "o", "n"),
    ).rejects.toThrow(/422.*name already exists/);
  });

  // Regression for 2026-04-17: template-created repos landed with Actions
  // disabled in the the-wolfpack-agency org, so the first workflow
  // dispatch 404'd and the deploy failed. enableActions() removes the
  // manual "Enable Actions" click; the 404 retry handles GitHub's
  // transient post-create indexing delay.
  it("enableActions PUTs to /actions/permissions with enabled:true", async () => {
    const { client, calls } = makeClient([{ status: 204 }]);
    await enableActions(client, "the-wolfpack-agency/wolfpack-new");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/the-wolfpack-agency/wolfpack-new/actions/permissions",
    );
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      enabled: true,
      allowed_actions: "all",
    });
  });

  it("triggerWorkflow retries on 404 and succeeds when GitHub indexes the workflow", async () => {
    const { client, calls } = makeClient([
      { status: 404, text: '{"message":"Not Found"}' },
      { status: 204 },
    ]);
    await triggerWorkflow(client, "the-wolfpack-agency/wolfpack-x", "canary-deploy.yml", "main");
    expect(calls).toHaveLength(2);
  });

  it("triggerWorkflow gives up after 4 consecutive 404s", async () => {
    // Skip the real backoff sleeps — we only care that the retry budget
    // is 4 attempts and that a non-404 is surfaced (asserted separately).
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      const { client, calls } = makeClient([
        { status: 404, text: "not found" },
        { status: 404, text: "not found" },
        { status: 404, text: "not found" },
        { status: 404, text: "not found" },
      ]);
      await expect(
        triggerWorkflow(client, "the-wolfpack-agency/wolfpack-x", "canary-deploy.yml", "main"),
      ).rejects.toThrow(/404/);
      expect(calls).toHaveLength(4);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("triggerWorkflow does NOT retry on non-404 errors", async () => {
    const { client, calls } = makeClient([{ status: 403, text: "forbidden" }]);
    await expect(
      triggerWorkflow(client, "the-wolfpack-agency/wolfpack-x", "canary-deploy.yml", "main"),
    ).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});
