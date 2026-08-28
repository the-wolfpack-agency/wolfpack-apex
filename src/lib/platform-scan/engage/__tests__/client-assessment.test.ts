/**
 * Assessing a client's live system, from granted access rather than source.
 *
 * runEngagement() begins with `if (!manifest?.static) return EMPTY(platform,
 * "no_static_target")`. A static target is a GitHub owner and repo, so the
 * existing sweep can only assess a platform whose source we already hold, and
 * it silently skips everything else.
 *
 * That is the wrong shape for the engagement this is sold into. A client
 * grants access to systems they run. We do not get their repository, and
 * asking for it on day one is the wrong first conversation.
 *
 * Most of what is asserted here is about refusing and about honesty, because
 * those are the two ways a client assessment does damage: scanning something
 * nobody authorised, or handing over a thin result that reads as thorough.
 */
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

const mockRecordScan = jest.fn();
jest.mock("@/lib/platform-scan/store", () => ({
  recordScan: (...a: unknown[]) => mockRecordScan(...a),
}));

import { runClientAssessment } from "@/lib/platform-scan/engage/client-assessment";

const actor = { userId: "u1", role: "cto" };
const base = {
  workspaceId: "ws1",
  platform: "ford-portal",
  baseUrl: "https://portal.example.com",
  actor,
};

const routes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `/p${i}`, method: "GET" as const }));

const deps = (over: Record<string, unknown> = {}) => ({
  isVerified: jest.fn(async () => true),
  discover: jest.fn(async () => routes(3)),
  crawl: jest.fn(async () => []),
  scan: jest.fn(async () => ({ findings: [], coverage: {}, okCount: 3, routeCount: 3 })),
  login: jest.fn(async () => ({ cookie: "session=abc" })),
  mapFlows: jest.fn(async () => ({ entryPoints: [], exitPoints: [], pagesRead: 0 })),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordScan.mockResolvedValue({ findingCount: 0, criticalCount: 0 });
});

describe("the ownership floor", () => {
  /* Everything after this line sends traffic to somebody else's system. */
  it("scans nothing when ownership was never verified", async () => {
    const d = deps({ isVerified: jest.fn(async () => false) });
    const out = await runClientAssessment(base, d as never);

    expect(out.refused).toMatch(/ownership/i);
    expect(d.discover).not.toHaveBeenCalled();
    expect(d.scan).not.toHaveBeenCalled();
  });

  /* An unreadable answer is not a yes. The cost of being wrong is scanning a
     system nobody authorised us to touch. */
  it("treats an unreadable verification as unverified", async () => {
    const d = deps({
      isVerified: jest.fn(async () => {
        throw new Error("store unreachable");
      }),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.refused).toMatch(/ownership/i);
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("proceeds once ownership is verified", async () => {
    const d = deps();
    const out = await runClientAssessment(base, d as never);
    expect(out.refused).toBeUndefined();
    expect(d.scan).toHaveBeenCalled();
  });
});

describe("finding the surfaces", () => {
  /* A sitemap is one request and is what the site publishes about itself.
     Crawling is the fallback, not the default, because a scan is a guest on
     somebody's production system. */
  it("prefers the sitemap and does not crawl when one exists", async () => {
    const d = deps();
    const out = await runClientAssessment(base, d as never);

    expect(out.discoveredVia).toBe("sitemap");
    expect(d.crawl).not.toHaveBeenCalled();
  });

  it("falls back to crawling when there is no sitemap", async () => {
    const d = deps({
      discover: jest.fn(async () => []),
      crawl: jest.fn(async () => routes(4)),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.discoveredVia).toBe("crawl");
    expect(out.routesDiscovered).toBe(4);
  });

  it("crawls when the sitemap request fails outright", async () => {
    const d = deps({
      discover: jest.fn(async () => {
        throw new Error("404");
      }),
      crawl: jest.fn(async () => routes(2)),
    });
    const out = await runClientAssessment(base, d as never);
    expect(out.discoveredVia).toBe("crawl");
  });

  /* Nothing reachable is not a clean bill of health. */
  it("refuses rather than reporting a clean scan of nothing", async () => {
    const d = deps({
      discover: jest.fn(async () => []),
      crawl: jest.fn(async () => []),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.refused).toMatch(/no reachable pages/i);
    expect(out.findingCount).toBe(0);
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("bounds a first pass rather than scanning everything found", async () => {
    const d = deps({ discover: jest.fn(async () => routes(200)) });
    const out = await runClientAssessment(base, d as never);

    expect(out.routesDiscovered).toBe(60);
    expect((d.scan as jest.Mock).mock.calls[0][0].routes).toHaveLength(60);
  });
});

describe("what it says it did not do", () => {
  /* THE POINT OF THE WHOLE RESULT SHAPE. A report listing only what was found
     reads as complete, and "we found nothing there" and "we never looked
     there" are entirely different statements to put in front of a client. */
  it("names the boundary of the run every time", async () => {
    const out = await runClientAssessment(base, deps() as never);

    expect(out.notAssessed.length).toBeGreaterThan(0);
    const all = out.notAssessed.join(" ");
    expect(all).toMatch(/login/i);
    expect(all).toMatch(/source|repository/i);
  });

  it("says how many pages it left for a later pass", async () => {
    const d = deps({ discover: jest.fn(async () => routes(75)) });
    const out = await runClientAssessment(base, d as never);
    expect(out.notAssessed.join(" ")).toContain("15 further pages");
  });

  /* A crawl misses what a sitemap would have listed, and the client should be
     told which of the two they got. */
  it("adds the crawl-specific caveat only when it crawled", async () => {
    const viaSitemap = await runClientAssessment(base, deps() as never);
    expect(viaSitemap.notAssessed.join(" ")).not.toMatch(/form, a search box/i);

    const d = deps({ discover: jest.fn(async () => []), crawl: jest.fn(async () => routes(2)) });
    const viaCrawl = await runClientAssessment(base, d as never);
    expect(viaCrawl.notAssessed.join(" ")).toMatch(/form, a search box/i);
  });
});

describe("the record", () => {
  it("persists the scan through the one path that dedupes and alerts", async () => {
    await runClientAssessment(base, deps() as never);
    expect(mockRecordScan).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", actorId: "u1", actorRole: "cto" }),
    );
  });

  /* Counts come from the stored record, so this function cannot disagree with
     what was persisted. */
  it("reports the counts the store recorded, not its own tally", async () => {
    mockRecordScan.mockResolvedValue({ findingCount: 7, criticalCount: 2 });
    const out = await runClientAssessment(base, deps() as never);
    expect(out.findingCount).toBe(7);
    expect(out.criticalCount).toBe(2);
  });

  it("still returns a result when the scan could not be persisted", async () => {
    mockRecordScan.mockRejectedValue(new Error("db down"));
    const out = await runClientAssessment(base, deps() as never);
    expect(out.refused).toBeUndefined();
    expect(out.routesDiscovered).toBe(3);
  });

  it("records how the surfaces were found, so coverage can be judged later", async () => {
    await runClientAssessment(base, deps() as never);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.engagement_run",
      "u1",
      "cto",
      expect.objectContaining({ mode: "client_assessment", discovered_via: "sitemap" }),
    );
  });
});


/**
 * Getting the keys.
 *
 * An anonymous scan sees the front door. Signing in is what turns a scan into
 * a recon: a page that redirects to login when anonymous and returns content
 * when authenticated is a surface that exists and was invisible from outside,
 * which is exactly what has to be mapped before anybody plans work against it.
 */
describe("with credentials the client granted", () => {
  const access = { loginPath: "/login", username: "svc@example.com", password: "pw" };

  it("signs in before mapping", async () => {
    const d = deps();
    await runClientAssessment({ ...base, access }, d as never);
    expect(d.login).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: base.baseUrl, loginPath: "/login" }),
    );
  });

  /* THE ANONYMOUS PASS RUNS ANYWAY. It is the only way to learn which surfaces
     are actually protected: a single authenticated crawl cannot tell a public
     page from a correctly gated one. */
  it("scans anonymously first, even when it holds credentials", async () => {
    const d = deps();
    await runClientAssessment({ ...base, access }, d as never);

    const calls = (d.scan as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].authenticated).toBeUndefined();
    expect(calls[0][0].headers).toBeUndefined();
  });

  /* authenticated:true flips the scanner's semantics: anonymously a bounce to
     login is correct enforcement, with a session it is the session not being
     honoured, which is a bug rather than a control. */
  it("tells the scanner the second pass carries a session", async () => {
    const d = deps();
    await runClientAssessment({ ...base, access }, d as never);

    const second = (d.scan as jest.Mock).mock.calls[1][0];
    expect(second.authenticated).toBe(true);
    expect(second.headers).toMatchObject({ Cookie: "session=abc" });
  });

  it("counts only the surfaces that signing in revealed", async () => {
    const d = deps({
      scan: jest
        .fn()
        .mockResolvedValueOnce({ findings: [], coverage: {}, okCount: 3, routeCount: 10 })
        .mockResolvedValueOnce({ findings: [], coverage: {}, okCount: 9, routeCount: 10 }),
    });
    const out = await runClientAssessment({ ...base, access }, d as never);

    expect(out.externalSurfaces).toBe(3);
    /* Nine reachable signed in, three of which were already public. */
    expect(out.internalSurfaces).toBe(6);
    expect(out.authenticated).toBe(true);
  });

  it("reports no hidden surfaces when everything was already public", async () => {
    const d = deps({
      scan: jest.fn(async () => ({ findings: [], coverage: {}, okCount: 5, routeCount: 5 })),
    });
    const out = await runClientAssessment({ ...base, access }, d as never);
    expect(out.internalSurfaces).toBe(0);
  });

  /* An assessment that returns nothing because a password was wrong is an
     assessment nobody runs twice. */
  it("still reports the public findings when the login fails", async () => {
    const d = deps({ login: jest.fn(async () => null) });
    const out = await runClientAssessment({ ...base, access }, d as never);

    expect(out.refused).toBeUndefined();
    expect(out.authenticated).toBe(false);
    expect(out.loginFailed).toMatch(/not accepted/i);
    expect((d.scan as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("survives a login that throws", async () => {
    const d = deps({
      login: jest.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    const out = await runClientAssessment({ ...base, access }, d as never);
    expect(out.authenticated).toBe(false);
    expect(out.loginFailed).toMatch(/sign-in attempt failed/i);
  });

  /* The boundary statement has to change when the boundary changes, or it
     becomes a stock paragraph nobody reads. */
  it("stops claiming it could not see behind the login once it could", async () => {
    const anon = await runClientAssessment(base, deps() as never);
    expect(anon.notAssessed.join(" ")).toMatch(/behind a login/i);

    const authed = await runClientAssessment({ ...base, access }, deps() as never);
    expect(authed.notAssessed.join(" ")).not.toMatch(/behind a login/i);
  });

  it("runs anonymously when no credentials were granted", async () => {
    const d = deps();
    const out = await runClientAssessment(base, d as never);
    expect(d.login).not.toHaveBeenCalled();
    expect(out.authenticated).toBe(false);
  });
});


/**
 * The map, not just the faults.
 *
 * A finding list says what is broken. A data-flow map says what the system IS,
 * and it is the part a client usually cannot produce themselves: nobody has a
 * current list of every form on their estate or every vendor their pages
 * contact.
 */
describe("data flows", () => {
  it("maps the routes it assessed", async () => {
    const d = deps();
    await runClientAssessment(base, d as never);
    expect(d.mapFlows).toHaveBeenCalledWith(
      base.baseUrl,
      expect.arrayContaining(["/p0", "/p1", "/p2"]),
    );
  });

  it("returns the entry and exit points it found", async () => {
    const d = deps({
      mapFlows: jest.fn(async () => ({
        entryPoints: [
          { page: "/checkout", action: "https://pay.vendor.io/x", method: "POST", crossOrigin: true, sensitiveFields: ["card_number"] },
        ],
        exitPoints: [{ origin: "https://pay.vendor.io", via: ["form"], pages: ["/checkout"] }],
        pagesRead: 4,
      })),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.dataFlows.entryPoints[0].crossOrigin).toBe(true);
    expect(out.dataFlows.exitPoints[0].origin).toBe("https://pay.vendor.io");
    expect(out.dataFlows.pagesRead).toBe(4);
  });

  /* A map we could not draw is not a reason to lose the findings. */
  it("still reports the scan when the map fails", async () => {
    const d = deps({
      mapFlows: jest.fn(async () => {
        throw new Error("network");
      }),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.refused).toBeUndefined();
    expect(out.routesDiscovered).toBe(3);
    expect(out.dataFlows).toEqual({ entryPoints: [], exitPoints: [], pagesRead: 0 });
  });

  it("does not attempt a map when nothing was reachable", async () => {
    const d = deps({ discover: jest.fn(async () => []), crawl: jest.fn(async () => []) });
    await runClientAssessment(base, d as never);
    expect(d.mapFlows).not.toHaveBeenCalled();
  });
});


/**
 * The recon has to end in a plan, not a list.
 *
 * A list of facts leaves the client to work out what matters. An ordered plan
 * says what to do first, which is the whole point of handing an engineer the
 * keys.
 */
describe("the plan of attack", () => {
  it("turns a leaking form into a critical recommendation", async () => {
    const d = deps({
      mapFlows: jest.fn(async () => ({
        entryPoints: [
          {
            page: "/checkout",
            action: "https://pay.vendor.io/x",
            method: "POST",
            crossOrigin: true,
            sensitiveFields: ["card_number"],
          },
        ],
        exitPoints: [],
        pagesRead: 3,
      })),
    });
    const out = await runClientAssessment(base, d as never);

    expect(out.recommendations.some((r) => r.priority === "critical")).toBe(true);
  });

  it("proposes automation for a vendor the pages already contact", async () => {
    const d = deps({
      mapFlows: jest.fn(async () => ({
        entryPoints: [],
        exitPoints: [{ origin: "https://js.stripe.com", via: ["script"], pages: ["/a"] }],
        pagesRead: 1,
      })),
    });
    const out = await runClientAssessment(base, d as never);
    expect(out.recommendations.some((r) => r.source === "data_flow:vendor:Stripe")).toBe(true);
  });

  /* An empty map means no plan, rather than filler that makes the report look
     substantial. */
  it("recommends nothing when there is nothing to recommend", async () => {
    const out = await runClientAssessment(base, deps() as never);
    expect(out.recommendations).toEqual([]);
  });
});
