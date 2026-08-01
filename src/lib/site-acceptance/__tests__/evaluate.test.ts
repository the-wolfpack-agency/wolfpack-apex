/**
 * The verdict rules. Most of these describe a broken build, which is exactly the
 * state an end-to-end test cannot produce on demand: the value of the layer is
 * that it says no, so saying no is what gets tested hardest here.
 */
import { evaluateAcceptance, type AcceptanceObservations } from "../evaluate";
import { parseCriteria } from "../criteria";

const obs = (over: Partial<AcceptanceObservations> = {}): AcceptanceObservations => ({
  deployedUrl: "https://build.test",
  routes: [{ path: "/", status: 200, body: "<h1>Acme</h1>" }],
  layout: {},
  ...over,
});

const byId = (v: ReturnType<typeof evaluateAcceptance>) => Object.fromEntries(v.checks.map((c) => [c.id, c]));

describe("evaluateAcceptance", () => {
  it("accepts a build that meets every stated criterion", () => {
    const v = evaluateAcceptance(parseCriteria({ requiredContent: ["Acme"], requireFontParity: false }), obs());
    expect(v.accepted).toBe(true);
    expect(v.degraded).toBe(false);
    expect(v.summary).toMatch(/^Accepted/);
  });

  it("fails a route that answers anything other than 2xx, including a redirect to a login", () => {
    // A 401 or a 302 to /login renders a blank page to a client just as a 500 does.
    for (const status of [301, 401, 404, 500]) {
      const v = evaluateAcceptance(parseCriteria(null), obs({ routes: [{ path: "/", status }] }));
      expect(byId(v).routes.status).toBe("failed");
      expect(v.accepted).toBe(false);
    }
  });

  it("treats a route that never answered as failed, and says what happened", () => {
    const v = evaluateAcceptance(parseCriteria(null), obs({ routes: [{ path: "/", status: null, error: "ETIMEDOUT" }] }));
    expect(byId(v).routes.status).toBe("failed");
    expect(byId(v).routes.detail).toMatch(/ETIMEDOUT/);
  });

  it("treats a required route that was never checked as UNMEASURED, not as a pass", () => {
    const v = evaluateAcceptance(parseCriteria({ requiredRoutes: ["/", "/about"] }), obs());
    expect(byId(v).routes.status).toBe("unmeasured");
    expect(v.accepted).toBe(false);
    expect(v.degraded).toBe(true);
    expect(v.summary).toMatch(/could not be checked/);
  });

  it("fails required content that is absent, and does not claim absence from a body it never read", () => {
    const missing = evaluateAcceptance(parseCriteria({ requiredContent: ["Wolfpack"] }), obs());
    expect(byId(missing).content.status).toBe("failed");

    const unread = evaluateAcceptance(parseCriteria({ requiredContent: ["Acme"] }), obs({ routes: [{ path: "/", status: 200 }] }));
    expect(byId(unread).content.status).toBe("unmeasured");
  });

  it("matches required content case-insensitively across every page it read", () => {
    const v = evaluateAcceptance(
      parseCriteria({ requiredRoutes: ["/", "/about"], requiredContent: ["acme"] }),
      obs({
        routes: [
          { path: "/", status: 200, body: "<h1>Home</h1>" },
          { path: "/about", status: 200, body: "<p>ACME Ltd</p>" },
        ],
      }),
    );
    expect(byId(v).content.status).toBe("passed");
  });

  it("skips the layout comparison when the project has no prototype, and still accepts", () => {
    const v = evaluateAcceptance(parseCriteria({ requireFontParity: false }), obs());
    expect(byId(v).layout.status).toBe("skipped");
    expect(v.accepted).toBe(true);
  });

  it("treats a comparison that could not run as UNMEASURED, so a browser failure is never a green build", () => {
    const v = evaluateAcceptance(
      parseCriteria({ prototypeUrl: "https://proto.test" }),
      obs({ layout: { error: "browser_unavailable" } }),
    );
    expect(byId(v).layout.status).toBe("unmeasured");
    expect(byId(v).font.status).toBe("unmeasured");
    expect(v.accepted).toBe(false);
    expect(v.degraded).toBe(true);
  });

  it("refuses to read zero matched elements as a perfect match", () => {
    // Zero diffs out of zero comparisons is a broken run wearing a passing costume.
    const v = evaluateAcceptance(
      parseCriteria({ prototypeUrl: "https://proto.test" }),
      obs({ layout: { summary: { totalDiffs: 0, totalMissing: 40, fontMismatch: false, matchedElements: 0, clean: true, worstOffenders: [] } } }),
    );
    expect(byId(v).layout.status).toBe("unmeasured");
    expect(v.accepted).toBe(false);
  });

  it("fails when differences exceed the allowance, and passes when the allowance covers them", () => {
    const summary = { totalDiffs: 12, totalMissing: 0, fontMismatch: false, matchedElements: 80, clean: false, worstOffenders: [] };
    const strict = evaluateAcceptance(parseCriteria({ prototypeUrl: "https://proto.test" }), obs({ layout: { summary } }));
    expect(byId(strict).layout.status).toBe("failed");
    expect(byId(strict).layout.detail).toMatch(/12 element/);

    const relaxed = evaluateAcceptance(
      parseCriteria({ prototypeUrl: "https://proto.test", maxLayoutDiffs: 20 }),
      obs({ layout: { summary } }),
    );
    expect(byId(relaxed).layout.status).toBe("passed");
  });

  it("fails font parity when the build serves a different typeface", () => {
    const v = evaluateAcceptance(
      parseCriteria({ prototypeUrl: "https://proto.test" }),
      obs({ layout: { summary: { totalDiffs: 0, totalMissing: 0, fontMismatch: true, matchedElements: 90, clean: false, worstOffenders: [] } } }),
    );
    expect(byId(v).font.status).toBe("failed");
    expect(v.accepted).toBe(false);
    expect(v.degraded).toBe(false); // a real failure, not an absence of measurement
  });

  it("reports failures and unmeasured checks separately, because they need different fixes", () => {
    const v = evaluateAcceptance(
      parseCriteria({ prototypeUrl: "https://proto.test", requiredRoutes: ["/", "/pricing"] }),
      obs({
        routes: [
          { path: "/", status: 200, body: "ok" },
          { path: "/pricing", status: 500 },
        ],
        layout: { error: "timeout" },
      }),
    );
    expect(v.summary).toMatch(/failed/);
    expect(v.summary).toMatch(/could not be checked/);
  });
});
