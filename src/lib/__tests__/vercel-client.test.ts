/**
 * vercel-client tests — verifies the Vercel REST wrapper sends the right
 * HTTP shape (method, URL, auth header, user-agent), treats 404 as an
 * idempotent success on DELETE, and refuses to construct a default client
 * when required env vars are missing. Uses an injected fetch stub so no
 * network is touched — mirrors the pattern in sites-github.test.ts.
 */

import {
  VercelApiError,
  defaultVercelClient,
  deleteProject,
  findProjectByName,
  type VercelClient,
} from "@/lib/vercel-client";

function makeClient(responses: Array<{ status?: number; json?: unknown; text?: string }>): {
  client: VercelClient;
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
  return {
    client: {
      token: "vercel_test_token",
      teamId: "team_test_01",
      fetch: fetchStub,
    },
    calls,
  };
}

describe("vercel-client / defaultVercelClient", () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.VERCEL_TOKEN_WOLFPACK_AGENCY;
    delete process.env.VERCEL_ORG_ID;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("throws when VERCEL_TOKEN_WOLFPACK_AGENCY is missing", () => {
    process.env.VERCEL_ORG_ID = "team_01";
    expect(() => defaultVercelClient()).toThrow(/VERCEL_TOKEN_WOLFPACK_AGENCY/);
  });

  it("throws when VERCEL_ORG_ID is missing", () => {
    process.env.VERCEL_TOKEN_WOLFPACK_AGENCY = "tkn_abc";
    expect(() => defaultVercelClient()).toThrow(/VERCEL_ORG_ID/);
  });

  it("throws an error that names BOTH env vars when both are missing", () => {
    expect(() => defaultVercelClient()).toThrow(/VERCEL_TOKEN_WOLFPACK_AGENCY.*VERCEL_ORG_ID/);
  });

  it("succeeds when both env vars are set", () => {
    process.env.VERCEL_TOKEN_WOLFPACK_AGENCY = "tkn_abc";
    process.env.VERCEL_ORG_ID = "team_01";
    const c = defaultVercelClient();
    expect(c.token).toBe("tkn_abc");
    expect(c.teamId).toBe("team_01");
    expect(typeof c.fetch).toBe("function");
  });
});

describe("vercel-client / findProjectByName", () => {
  it("GETs /v9/projects/{name}?teamId=… with Bearer auth + user-agent", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        json: {
          id: "prj_abc",
          name: "wolfpack-x",
          framework: "nextjs",
          gitRepository: { repo: "the-wolfpack-agency/wolfpack-x", type: "github" },
        },
      },
    ]);
    const out = await findProjectByName(client, "wolfpack-x");
    expect(out).toEqual({
      id: "prj_abc",
      name: "wolfpack-x",
      framework: "nextjs",
      gitRepository: { repo: "the-wolfpack-agency/wolfpack-x", type: "github" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.vercel.com/v9/projects/wolfpack-x?teamId=team_test_01",
    );
    expect(calls[0].init.method).toBe("GET");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer vercel_test_token");
    expect(headers["User-Agent"]).toBe("wolfpack-instinct-sites");
  });

  it("returns null on 404", async () => {
    const { client } = makeClient([{ status: 404, text: "not found" }]);
    const out = await findProjectByName(client, "does-not-exist");
    expect(out).toBeNull();
  });

  it("throws VercelApiError on 500 (preserves status)", async () => {
    const { client } = makeClient([{ status: 500, text: "internal" }]);
    await expect(findProjectByName(client, "wolfpack-x")).rejects.toThrow(VercelApiError);
    // Re-run to inspect status (promise already rejected above, but we need a fresh call).
    const { client: c2 } = makeClient([{ status: 500, text: "internal" }]);
    try {
      await findProjectByName(c2, "wolfpack-x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VercelApiError);
      expect((err as VercelApiError).status).toBe(500);
      expect((err as VercelApiError).body).toBe("internal");
    }
  });

  it("URL-encodes the name segment (spaces, slashes)", async () => {
    const { client, calls } = makeClient([
      { status: 200, json: { id: "prj_1", name: "weird name/slash" } },
    ]);
    await findProjectByName(client, "weird name/slash");
    // encodeURIComponent: space → %20, / → %2F
    expect(calls[0].url).toBe(
      "https://api.vercel.com/v9/projects/weird%20name%2Fslash?teamId=team_test_01",
    );
  });

  it("coerces the newer `link` shape into gitRepository", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          id: "prj_abc",
          name: "wolfpack-x",
          framework: null,
          link: { repo: "the-wolfpack-agency/wolfpack-x", type: "github" },
        },
      },
    ]);
    const out = await findProjectByName(client, "wolfpack-x");
    expect(out?.gitRepository).toEqual({
      repo: "the-wolfpack-agency/wolfpack-x",
      type: "github",
    });
  });

  it("returns null gitRepository when Vercel returns neither shape", async () => {
    const { client } = makeClient([
      { status: 200, json: { id: "prj_abc", name: "wolfpack-x" } },
    ]);
    const out = await findProjectByName(client, "wolfpack-x");
    expect(out?.gitRepository).toBeNull();
    expect(out?.framework).toBeNull();
  });
});

describe("vercel-client / deleteProject", () => {
  it("DELETEs /v9/projects/{id}?teamId=… with Bearer auth + user-agent", async () => {
    const { client, calls } = makeClient([{ status: 200, json: {} }]);
    const out = await deleteProject(client, "prj_abc");
    expect(out).toEqual({ ok: true, alreadyGone: false });
    expect(calls[0].url).toBe(
      "https://api.vercel.com/v9/projects/prj_abc?teamId=team_test_01",
    );
    expect(calls[0].init.method).toBe("DELETE");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer vercel_test_token");
    expect(headers["User-Agent"]).toBe("wolfpack-instinct-sites");
  });

  it("resolves alreadyGone:false on 204", async () => {
    const { client } = makeClient([{ status: 204 }]);
    const out = await deleteProject(client, "prj_abc");
    expect(out).toEqual({ ok: true, alreadyGone: false });
  });

  it("resolves alreadyGone:true on 404 (idempotent)", async () => {
    const { client } = makeClient([{ status: 404, text: "not found" }]);
    const out = await deleteProject(client, "prj_gone");
    expect(out).toEqual({ ok: true, alreadyGone: true });
  });

  it("throws VercelApiError on 500 (status + body preserved)", async () => {
    const { client } = makeClient([{ status: 500, text: "kaboom" }]);
    try {
      await deleteProject(client, "prj_abc");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VercelApiError);
      expect((err as VercelApiError).status).toBe(500);
      expect((err as VercelApiError).body).toBe("kaboom");
      expect((err as Error).message).toMatch(/vercel 500/);
    }
  });

  it("throws VercelApiError on 403 (auth / permission failures are not swallowed)", async () => {
    const { client } = makeClient([{ status: 403, text: "forbidden" }]);
    await expect(deleteProject(client, "prj_abc")).rejects.toThrow(VercelApiError);
    const { client: c2 } = makeClient([{ status: 403, text: "forbidden" }]);
    try {
      await deleteProject(c2, "prj_abc");
    } catch (err) {
      expect((err as VercelApiError).status).toBe(403);
    }
  });

  it("URL-encodes the idOrName segment (spaces, slashes)", async () => {
    const { client, calls } = makeClient([{ status: 200, json: {} }]);
    await deleteProject(client, "weird name/slash");
    expect(calls[0].url).toBe(
      "https://api.vercel.com/v9/projects/weird%20name%2Fslash?teamId=team_test_01",
    );
  });
});
