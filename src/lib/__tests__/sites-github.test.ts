/**
 * github-client tests — verifies our GitHub API wrapper sends the right
 * HTTP shape and refuses to call without a token. Uses an injected fetch
 * stub so no network is touched.
 */

import {
  createRepoFromTemplate,
  deleteRepo,
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

  // Regression for 2026-04-18 broken asset uploads: every image committed
  // via /api/sites/[id]/assets was corrupt because the route passed
  // buffer.toString("base64") as `content` and putFile then
  // UTF-8-encoded-then-base64-encoded that string again, producing
  // garbage bytes. Symptom: 404 on every /cftr/IMG_*.jpg in the
  // deployed client-site preview. putFile must accept Buffer and
  // base64 directly.
  it("putFile base64-encodes a Buffer directly (no double-encoding of binary)", async () => {
    const { client, calls } = makeClient([
      { status: 404, text: "not found" },
      { status: 201, json: {} },
    ]);
    // JPEG magic bytes — use a real binary payload so a double-encode
    // would produce a detectably wrong output.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await putFile(
      client,
      "the-wolfpack-agency/wolfpack-x",
      "public/cftr/hero.jpg",
      jpeg,
      "chore: upload hero",
    );
    const putBody = JSON.parse(calls[1].init.body as string);
    // Decode the base64 we sent and assert it matches the original bytes
    // exactly — single base64-encode round-trips, double would corrupt.
    const roundTripped = Buffer.from(putBody.content, "base64");
    expect(roundTripped).toEqual(jpeg);
  });

  it("putFile still handles text content as UTF-8 → base64", async () => {
    const { client, calls } = makeClient([
      { status: 404, text: "not found" },
      { status: 201, json: {} },
    ]);
    await putFile(client, "a/b", "briefs/x.json", '{"hello":"world"}', "msg");
    const putBody = JSON.parse(calls[1].init.body as string);
    expect(Buffer.from(putBody.content, "base64").toString("utf-8")).toBe('{"hello":"world"}');
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
  // instinct_site_deploys row.
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

  // deleteRepo — regression for the 2026-04-18 hard-delete flow
  it("deleteRepo DELETEs /repos/{fullName} and resolves ok", async () => {
    const { client, calls } = makeClient([{ status: 204 }]);
    const res = await deleteRepo(client, "the-wolfpack-agency/wolfpack-x");
    expect(calls[0].url).toBe("https://api.github.com/repos/the-wolfpack-agency/wolfpack-x");
    expect(calls[0].init.method).toBe("DELETE");
    expect(res).toEqual({ ok: true, alreadyGone: false });
  });

  it("deleteRepo treats 404 as idempotent success (already gone)", async () => {
    const { client } = makeClient([{ status: 404, text: "not found" }]);
    const res = await deleteRepo(client, "the-wolfpack-agency/wolfpack-gone");
    expect(res).toEqual({ ok: true, alreadyGone: true });
  });

  it("deleteRepo throws on non-404 errors (e.g. 403 missing permission)", async () => {
    const { client } = makeClient([{ status: 403, text: "forbidden" }]);
    await expect(
      deleteRepo(client, "the-wolfpack-agency/wolfpack-x"),
    ).rejects.toThrow(/403/);
  });

  it("triggerWorkflow does NOT retry on non-404 errors", async () => {
    const { client, calls } = makeClient([{ status: 403, text: "forbidden" }]);
    await expect(
      triggerWorkflow(client, "the-wolfpack-agency/wolfpack-x", "canary-deploy.yml", "main"),
    ).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});
