/**
 * scanSource aggregation with an injected readFile: one buggy path (fires), one
 * clean path (counts ok), one missing path (null, skipped). Asserts the
 * PlatformScanResult counts and shape.
 */
import { scanSource, defaultReadFile } from "@/lib/platform-scan/static/scan";

const BUGGY = [
  '"use client";',
  "export default function Page() {",
  "  const dealer = process.env.DEALER_ID;",
  '  const res = fetch("/api/leads");',
  "  return res.json();",
  "}",
].join("\n");

const CLEAN = [
  "export async function GET() {",
  "  const res = await fetch(`https://example.com`);",
  "  if (!res.ok) throw new Error('bad');",
  "  return res.json();",
  "}",
].join("\n");

describe("scanSource", () => {
  it("aggregates findings across buggy / clean / missing paths", async () => {
    const files: Record<string, string | null> = {
      "app/page.tsx": BUGGY,
      "app/api/route.ts": CLEAN,
      "app/missing.tsx": null,
    };
    const readFile = jest.fn(async (path: string) => files[path] ?? null);

    const result = await scanSource({
      platform: "wolfpack-auto",
      owner: "wolfpack",
      repo: "auto",
      paths: ["app/page.tsx", "app/api/route.ts", "app/missing.tsx"],
      readFile,
    });

    expect(result.platform).toBe("wolfpack-auto");
    expect(result.baseUrl).toBe("github:wolfpack/auto");
    expect(result.routeCount).toBe(3);
    // clean file counts ok; buggy file does not; missing file is skipped.
    expect(result.okCount).toBe(1);
    // buggy file fires silentFetch + hardcodedTenantId (the raw-fetch detector
    // was removed as an apex-specific false-positive source).
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.category).sort()).toEqual(["bug", "security"]);
    expect(result.findings.every((f) => f.route === "app/page.tsx")).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("reports zero findings and full okCount when every file is clean", async () => {
    const result = await scanSource({
      platform: "p",
      owner: "o",
      repo: "r",
      ref: "develop",
      paths: ["a.tsx", "b.tsx"],
      readFile: async () => CLEAN,
    });
    expect(result.okCount).toBe(2);
    expect(result.findings).toHaveLength(0);
    expect(result.routeCount).toBe(2);
  });
});

describe("defaultReadFile", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  });

  it("returns text on 200 via the GitHub Contents API (raw media type) with ref", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => "file body",
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    const read = defaultReadFile("owner", "repo", "feature");
    const out = await read("src/x.ts");
    expect(out).toBe("file body");
    const [calledUrl, opts] = (fetchMock as unknown as jest.Mock).mock.calls[0];
    // Contents API (works for private repos too), raw media type, ref as query.
    expect(calledUrl).toBe("https://api.github.com/repos/owner/repo/contents/src/x.ts?ref=feature");
    expect(opts.headers.Accept).toBe("application/vnd.github.raw");
  });

  it("sends a Bearer header when GITHUB_TOKEN_WOLFPACK_AGENCY is set", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "secret-token";
    const fetchMock = jest.fn(async () => ({ status: 200, text: async () => "x" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await defaultReadFile("o", "r")("p");
    const opts = (fetchMock as unknown as jest.Mock).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer secret-token");
  });

  it("defaults ref to main and omits Authorization when no token", async () => {
    const fetchMock = jest.fn(async () => ({ status: 200, text: async () => "x" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await defaultReadFile("o", "r")("p");
    const [url, opts] = (fetchMock as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/o/r/contents/p?ref=main");
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("returns null on non-200", async () => {
    global.fetch = (async () => ({ status: 404, text: async () => "" })) as unknown as typeof fetch;
    expect(await defaultReadFile("o", "r")("p")).toBeNull();
  });

  it("returns null (never throws) on a network error", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await defaultReadFile("o", "r")("p")).toBeNull();
  });
});
