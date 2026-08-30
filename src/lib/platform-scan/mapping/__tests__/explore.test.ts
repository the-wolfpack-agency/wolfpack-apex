/**
 * Deciding where to look next on someone else's production system.
 *
 * Most of these tests are refusals. This walks a client's live CRM while logged
 * in as a real user, so the interesting question is never "did it find enough"
 * — it is "did it touch something it should not have", and "did it claim more
 * coverage than it earned".
 */
import {
  budgetExceeded,
  buildSystemMap,
  DEFAULT_BUDGET,
  derivePaths,
  describeCoverage,
  Frontier,
  shouldFollow,
  signatureOf,
} from "../explore";
import type { MapCoverage, MappedSurface } from "../types";

const ORIGIN = "https://acme.my.salesforce.com";

function ctx(over: Partial<Parameters<typeof shouldFollow>[1]> = {}) {
  return { origin: ORIGIN, seen: new Set<string>(), depth: 0, maxDepth: 4, ...over };
}

function surface(over: Partial<MappedSurface> = {}): MappedSurface {
  return {
    url: `${ORIGIN}/lightning/o/Account/list`,
    signature: "/lightning/o/account/list",
    title: "Accounts",
    depth: 1,
    headings: ["Accounts"],
    linksTo: [],
    forms: [],
    tables: [],
    status: 200,
    loadMs: 400,
    ...over,
  };
}

describe("one screen, not a hundred thousand records", () => {
  it("collapses record ids so a CRM does not explode the map", () => {
    // The difference between a map of a system and a list of its rows.
    const a = signatureOf(`${ORIGIN}/lightning/r/Account/001xx000003DGb1AAG/view`);
    const b = signatureOf(`${ORIGIN}/lightning/r/Account/001xx000003DGb2AAG/view`);
    expect(a).toBe(b);
    expect(a).toContain(":id");
  });

  it.each([
    ["/orders/12345", "numeric id"],
    ["/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301", "uuid"],
    ["/reports/2026-08-02", "date"],
  ])("collapses %s (%s)", (path) => {
    expect(signatureOf(`${ORIGIN}${path}`)).toContain(":id");
  });

  it("keeps view-selecting query params, which name different SCREENS", () => {
    // A list and a report can differ only by ?view=. Dropping it merges two
    // genuinely different surfaces and loses half the map.
    const list = signatureOf(`${ORIGIN}/o/Account?view=list`);
    const kanban = signatureOf(`${ORIGIN}/o/Account?view=kanban`);
    expect(list).not.toBe(kanban);
  });

  it("drops noise params, which name the same screen", () => {
    const a = signatureOf(`${ORIGIN}/o/Account?utm_source=email&t=123`);
    const b = signatureOf(`${ORIGIN}/o/Account`);
    expect(a).toBe(b);
  });
});

describe("what it refuses to touch", () => {
  it.each([
    "/secur/logout.jsp",
    "/setup/deleteUser",
    "/records/123/destroy",
    "/account/deactivate",
    "/billing/cancel-subscription",
    "/setup/deactivateAccount",
    "/data/purgeRecords",
    "/admin/removeMember",
    "/api/v1/revoke_token",
  ])("refuses %s by name", (path) => {
    // A destructive action reached by a GET link is still destructive, and the
    // read-only network floor cannot see intent — only the name gives it away.
    // camelCase matters: /setup/deleteUser slipped through the first version,
    // because \bdelete\b does not match a verb glued to its noun, and that is
    // exactly how enterprise systems name these.
    const decision = shouldFollow(`${ORIGIN}${path}`, ctx());
    expect(decision.follow).toBe(false);
    if (!decision.follow) expect(decision.reason).toBe("dangerous");
  });

  it("never leaves the origin it was authorised for", () => {
    // A client system links outward constantly. Following those means scanning
    // systems nobody authorised us to touch.
    for (const url of ["https://help.salesforce.com/docs", "https://status.example.com", "https://evil.example.net"]) {
      const decision = shouldFollow(url, ctx());
      expect(decision.follow).toBe(false);
      if (!decision.follow) expect(decision.reason).toBe("off-origin");
    }
  });

  it("refuses a non-http scheme", () => {
    for (const url of ["mailto:sales@acme.com", "tel:+15551234", "javascript:void(0)"]) {
      expect(shouldFollow(url, ctx()).follow).toBe(false);
    }
  });

  it("does not revisit a surface it has already mapped", () => {
    const seen = new Set([signatureOf(`${ORIGIN}/o/Account/list`)]);
    const decision = shouldFollow(`${ORIGIN}/o/Account/list`, ctx({ seen }));
    expect(decision.follow).toBe(false);
    if (!decision.follow) expect(decision.reason).toBe("already-seen");
  });

  it("stops descending at the depth limit", () => {
    const decision = shouldFollow(`${ORIGIN}/deep/page`, ctx({ depth: 4, maxDepth: 4 }));
    expect(decision.follow).toBe(false);
    if (!decision.follow) expect(decision.reason).toBe("too-deep");
  });

  it("follows an ordinary in-origin link", () => {
    expect(shouldFollow(`${ORIGIN}/lightning/o/Opportunity/list`, ctx()).follow).toBe(true);
  });
});

describe("the frontier reaches the navigation tree, not one record's depths", () => {
  it("is breadth-first", () => {
    // Depth-first on a CRM disappears into related lists and produces a deep,
    // narrow map of nothing useful.
    const f = new Frontier(new Set());
    f.add(`${ORIGIN}/a`, 1);
    f.add(`${ORIGIN}/b`, 1);
    expect(f.next()?.url).toBe(`${ORIGIN}/a`);
    expect(f.next()?.url).toBe(`${ORIGIN}/b`);
  });

  it("queues a signature only once, however many links point at it", () => {
    // Every page in a CRM links to the home tab.
    const f = new Frontier(new Set());
    expect(f.add(`${ORIGIN}/r/Account/001xx000003DGb1AAG/view`, 1)).toBe(true);
    expect(f.add(`${ORIGIN}/r/Account/001xx000003DGb2AAG/view`, 1)).toBe(false);
    expect(f.size).toBe(1);
  });

  it("does not queue something already mapped", () => {
    const f = new Frontier(new Set([signatureOf(`${ORIGIN}/home`)]));
    expect(f.add(`${ORIGIN}/home`, 1)).toBe(false);
  });
});

describe("budgets", () => {
  it.each([
    [{ surfaces: 120, depth: 1, elapsedMs: 0 }, "page-budget"],
    [{ surfaces: 1, depth: 1, elapsedMs: 8 * 60 * 1000 }, "time-budget"],
    [{ surfaces: 1, depth: 5, elapsedMs: 0 }, "depth-budget"],
  ])("reports %j as %s", (state, expected) => {
    expect(budgetExceeded(state, DEFAULT_BUDGET)).toBe(expected);
  });

  it("returns null while there is room", () => {
    expect(budgetExceeded({ surfaces: 5, depth: 1, elapsedMs: 100 }, DEFAULT_BUDGET)).toBeNull();
  });
});

describe("coverage is stated before anything is claimed", () => {
  const coverage = (over: Partial<MapCoverage> = {}): MapCoverage => ({
    surfacesReached: 60,
    frontierRemaining: 340,
    skipped: [],
    patterns: [],
    maxDepthReached: 4,
    stopReason: "page-budget",
    durationMs: 1000,
    ...over,
  });

  it("says a truncated map is partial, and says why", () => {
    // The most damaging thing this feature could produce is a report that reads
    // as "here is your system" when it means "here are 60 of 400 screens".
    const text = describeCoverage(coverage(), "Salesforce");
    expect(text).toMatch(/stopped because the page limit was reached/);
    expect(text).toMatch(/340 more were still queued/);
    expect(text).toMatch(/partial map/);
    expect(text).toMatch(/what was seen, not the whole system/);
  });

  it("only claims completeness when the frontier genuinely emptied", () => {
    const text = describeCoverage(coverage({ stopReason: "frontier-exhausted", frontierRemaining: 0 }), "Salesforce");
    expect(text).toMatch(/Every screen reachable by following links/);
    expect(text).not.toMatch(/partial/);
  });

  it("does not claim completeness when the frontier emptied but work was refused", () => {
    // Refused work is not covered work.
    const text = describeCoverage(coverage({ stopReason: "refused", frontierRemaining: 12 }), "Salesforce");
    expect(text).toMatch(/partial map/);
  });

  it("cannot build a map without stating coverage", () => {
    const map = buildSystemMap({
      platform: "Salesforce",
      entryUrl: ORIGIN,
      surfaces: [surface()],
      entities: [],
      integrations: [],
      coverage: coverage(),
      now: "2026-08-02T00:00:00.000Z",
    });
    expect(map.headline).toContain("partial map");
  });
});

describe("user paths are derived, not guessed", () => {
  it("reports the route to a form as a path", () => {
    const home = surface({ signature: "/home", depth: 0, linksTo: ["/o/lead/list"] });
    const list = surface({ signature: "/o/lead/list", depth: 1, linksTo: ["/o/lead/new"] });
    const form = surface({
      signature: "/o/lead/new",
      depth: 2,
      forms: [{ name: "New Lead", method: "POST", fields: [], mutating: true }],
    });
    const [path] = derivePaths([home, list, form]);
    expect(path.steps).toEqual(["/home", "/o/lead/list", "/o/lead/new"]);
    expect(path.verified).toBe(true);
  });

  it("does not report a path that is only one step", () => {
    // A form with nothing linking to it is not a journey.
    const orphan = surface({
      signature: "/o/lead/new",
      forms: [{ name: "New Lead", method: "POST", fields: [], mutating: true }],
    });
    expect(derivePaths([orphan])).toEqual([]);
  });

  it("does not loop forever on a cycle", () => {
    // Every CRM screen links back to the one before it.
    const a = surface({ signature: "/a", linksTo: ["/b"] });
    const b = surface({
      signature: "/b",
      linksTo: ["/a"],
      forms: [{ name: "Edit", method: "POST", fields: [], mutating: true }],
    });
    expect(() => derivePaths([a, b])).not.toThrow();
  });

  it("returns nothing when no surface has a form", () => {
    expect(derivePaths([surface(), surface({ signature: "/other" })])).toEqual([]);
  });
});
