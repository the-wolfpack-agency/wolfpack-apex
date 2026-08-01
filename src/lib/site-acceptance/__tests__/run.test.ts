/**
 * The runner, with no network and no browser. The failure paths are the point:
 * a build is only trustworthy if "we could not check" is impossible to confuse
 * with "we checked and it was fine".
 */
import { runAcceptance, routeUrl, statusFromVerdict } from "../run";
import { parseCriteria } from "../criteria";

const ok = (body = "<h1>Acme</h1>") => ({ status: 200, text: async () => body }) as unknown as Response;
const fetchOk = jest.fn(async () => ok());

const cleanSummary = {
  totalDiffs: 0,
  totalMissing: 0,
  fontMismatch: false,
  matchedElements: 120,
  clean: true,
  worstOffenders: [] as { text: string; field: string; delta: number }[],
};

beforeEach(() => fetchOk.mockClear());

describe("routeUrl", () => {
  it("joins an origin and a path without doubling the slash", () => {
    expect(routeUrl("https://build.test/", "/about")).toBe("https://build.test/about");
    expect(routeUrl("https://build.test", "about")).toBe("https://build.test/about");
  });

  it("refuses a path that resolves off-origin", () => {
    expect(() => routeUrl("https://build.test", "//evil.test/x")).toThrow(/off-origin/);
  });
});

describe("runAcceptance", () => {
  it("probes every required route and accepts a healthy build", async () => {
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ requiredRoutes: ["/", "/about"], requiredContent: ["Acme"], requireFontParity: false }) },
      { fetchImpl: fetchOk as unknown as typeof fetch },
    );
    expect(fetchOk).toHaveBeenCalledTimes(2);
    expect(res.verdict.accepted).toBe(true);
    expect(statusFromVerdict(res.verdict)).toBe("passed");
  });

  it("does not follow redirects, so a 302 to a login is seen for what it is", async () => {
    const redirecting = jest.fn(async (_url: string, init?: RequestInit) => {
      void _url;
      void init;
      return { status: 302, text: async () => "" } as unknown as Response;
    });
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria(null) },
      { fetchImpl: redirecting as unknown as typeof fetch },
    );
    expect(redirecting.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(res.verdict.accepted).toBe(false);
    expect(statusFromVerdict(res.verdict)).toBe("failed");
  });

  it("records an unreachable route as an observation instead of throwing", async () => {
    const failing = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria(null) },
      { fetchImpl: failing as unknown as typeof fetch },
    );
    expect(res.observations.routes[0]).toMatchObject({ status: null, error: "ECONNREFUSED" });
    expect(res.verdict.accepted).toBe(false);
  });

  it("runs the layout comparison when a prototype is set, and carries its run id", async () => {
    const compareLayout = jest.fn(async () => ({ summary: cleanSummary, specDiffRunId: "run-1" }));
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ prototypeUrl: "https://proto.test" }) },
      { fetchImpl: fetchOk as unknown as typeof fetch, compareLayout },
    );
    expect(compareLayout).toHaveBeenCalledWith(expect.objectContaining({ prototypeUrl: "https://proto.test/", deployedUrl: "https://build.test/" }));
    expect(res.specDiffRunId).toBe("run-1");
    expect(res.verdict.accepted).toBe(true);
  });

  it("degrades rather than passes when the comparator throws", async () => {
    const compareLayout = jest.fn(async () => {
      throw new Error("browser_unavailable");
    });
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ prototypeUrl: "https://proto.test" }) },
      { fetchImpl: fetchOk as unknown as typeof fetch, compareLayout },
    );
    expect(res.verdict.accepted).toBe(false);
    expect(res.verdict.degraded).toBe(true);
    expect(statusFromVerdict(res.verdict)).toBe("degraded");
  });

  it("degrades when a prototype is required but no comparator exists in this environment", async () => {
    // A missing capability must never quietly become a passing build.
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ prototypeUrl: "https://proto.test" }) },
      { fetchImpl: fetchOk as unknown as typeof fetch },
    );
    expect(res.verdict.accepted).toBe(false);
    expect(res.observations.layout.error).toMatch(/no layout comparator/);
  });

  it("probes nothing when the deployed URL is refused by the SSRF guard", async () => {
    const assertPublicUrl = jest.fn(async () => {
      throw new Error("blocked: private address");
    });
    const res = await runAcceptance(
      { deployedUrl: "http://169.254.169.254/", criteria: parseCriteria(null) },
      { fetchImpl: fetchOk as unknown as typeof fetch, assertPublicUrl },
    );
    expect(fetchOk).not.toHaveBeenCalled();
    expect(res.verdict.accepted).toBe(false);
    expect(res.verdict.degraded).toBe(true);
  });

  it("checks the prototype URL through the same guard as the deploy", async () => {
    const assertPublicUrl = jest.fn(async (url: string) => {
      if (url.includes("proto")) throw new Error("blocked: private address");
    });
    const compareLayout = jest.fn(async () => ({ summary: cleanSummary }));
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ prototypeUrl: "https://proto.test" }) },
      { fetchImpl: fetchOk as unknown as typeof fetch, compareLayout, assertPublicUrl },
    );
    expect(compareLayout).not.toHaveBeenCalled();
    expect(res.verdict.accepted).toBe(false);
  });

  it("keeps route results when the comparison fails, so one failure does not lose the other evidence", async () => {
    const compareLayout = jest.fn(async () => ({ error: "timeout" }));
    const res = await runAcceptance(
      { deployedUrl: "https://build.test", criteria: parseCriteria({ prototypeUrl: "https://proto.test", requiredRoutes: ["/", "/about"] }) },
      { fetchImpl: fetchOk as unknown as typeof fetch, compareLayout },
    );
    expect(res.observations.routes).toHaveLength(2);
    expect(res.observations.routes.every((r) => r.status === 200)).toBe(true);
  });
});
