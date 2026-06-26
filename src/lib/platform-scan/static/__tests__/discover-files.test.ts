/**
 * discoverRepoFiles: enumerates a target repo's tree via the GitHub git/trees
 * API (recursive) and filters to the client UI / route source worth scanning.
 * fetchImpl is injected so these tests never hit the network. Asserts the URL +
 * recursive flag + Bearer header (when the env token is set), the include /
 * exclude filtering, the max cap, and that EVERY failure mode (non-200, thrown
 * fetch, malformed JSON) degrades to [] rather than throwing.
 */
import { discoverRepoFiles } from "@/lib/platform-scan/static/discover-files";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

const ENV_KEY = "GITHUB_TOKEN_WOLFPACK_AGENCY";

describe("discoverRepoFiles", () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("returns source files and excludes tests, README, .d.ts, and tree entries", async () => {
    process.env[ENV_KEY] = "tok-123";

    const tree = {
      truncated: false,
      tree: [
        { path: "src/app/admin/leads/page.tsx", type: "blob" },
        { path: "src/app/api/admin/leads/route.ts", type: "blob" },
        { path: "src/components/AdminSidebar.tsx", type: "blob" },
        { path: "src/app/admin/leads/__tests__/page.test.tsx", type: "blob" },
        { path: "README.md", type: "blob" },
        { path: "src/app/admin", type: "tree" },
        { path: "src/types.d.ts", type: "blob" },
      ],
    };

    const fetchImpl = jest.fn(async () => jsonResponse(tree));

    const result = await discoverRepoFiles("acme", "app", "main", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual([
      "src/app/admin/leads/page.tsx",
      "src/app/api/admin/leads/route.ts",
      "src/components/AdminSidebar.tsx",
    ]);

    // URL: GitHub git/trees endpoint, recursive flag present.
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(
      "https://api.github.com/repos/acme/app/git/trees/main?recursive=1",
    );
    expect(calledUrl).toContain("recursive=1");

    // Authorization header carries the env token as a Bearer.
    expect(calledInit.headers.Authorization).toBe("Bearer tok-123");
    expect(calledInit.headers.Accept).toBe("application/vnd.github+json");
    expect(calledInit.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("omits the Authorization header when the env token is unset", async () => {
    delete process.env[ENV_KEY];

    const fetchImpl = jest.fn(async () =>
      jsonResponse({ truncated: false, tree: [] }),
    );

    await discoverRepoFiles("acme", "app", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    // Defaults to the "main" branch when no ref is given.
    expect(calledUrl).toBe(
      "https://api.github.com/repos/acme/app/git/trees/main?recursive=1",
    );
    expect(calledInit.headers.Authorization).toBeUndefined();
  });

  it("respects the max cap, keeping API order", async () => {
    const tree = {
      truncated: false,
      tree: [
        { path: "src/app/a/page.tsx", type: "blob" },
        { path: "src/app/b/page.tsx", type: "blob" },
        { path: "src/app/c/page.tsx", type: "blob" },
        { path: "src/app/d/page.tsx", type: "blob" },
        { path: "src/app/e/page.tsx", type: "blob" },
      ],
    };

    const fetchImpl = jest.fn(async () => jsonResponse(tree));

    const result = await discoverRepoFiles("acme", "app", "main", {
      max: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual(["src/app/a/page.tsx", "src/app/b/page.tsx"]);
    expect(result).toHaveLength(2);
  });

  it("returns [] on a 404", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 404));
    const result = await discoverRepoFiles("acme", "missing", "main", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([]);
  });

  it("returns [] when fetch throws (network error / abort)", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });
    const result = await discoverRepoFiles("acme", "app", "main", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    }) as unknown as Response);
    const result = await discoverRepoFiles("acme", "app", "main", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([]);
  });
});
