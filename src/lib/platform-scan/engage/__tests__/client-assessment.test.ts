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
  scan: jest.fn(async () => ({ findings: [], coverage: {} })),
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
