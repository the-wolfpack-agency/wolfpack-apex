/**
 * The acceptance contract. These tests are the reason the contract is worth
 * having: an operator can be vague in prose, but every vague value that reaches
 * this parser is either normalized to something explicit or refused by name.
 */
import { parseCriteria, criteriaCompleteness, CriteriaError, DEFAULT_CRITERIA, LIMITS } from "../criteria";

describe("parseCriteria", () => {
  it("returns a real gate when the operator fills in nothing", () => {
    const c = parseCriteria(null);
    // A default that checks nothing would make the whole layer decorative.
    expect(c.requiredRoutes).toEqual(["/"]);
    expect(c.requireFontParity).toBe(true);
    expect(c.maxLayoutDiffs).toBe(0);
    expect(c.viewports.length).toBeGreaterThan(1);
  });

  it("does not hand back the shared default object, so one project cannot mutate another's", () => {
    const a = parseCriteria(null);
    a.viewports.push({ width: 800, height: 600 });
    expect(parseCriteria(null).viewports).toHaveLength(DEFAULT_CRITERIA.viewports.length);
  });

  it("normalizes routes to paths and always keeps at least the home page", () => {
    expect(parseCriteria({ requiredRoutes: ["about", "/contact", "about"] }).requiredRoutes).toEqual(["/about", "/contact"]);
    expect(parseCriteria({ requiredRoutes: [] }).requiredRoutes).toEqual(["/"]);
  });

  it("refuses a full URL as a route, because the check must follow the deploy", () => {
    // Pinning a check to a host means it can pass while the actual build is broken.
    expect(() => parseCriteria({ requiredRoutes: ["https://example.com/about"] })).toThrow(CriteriaError);
    expect(() => parseCriteria({ requiredRoutes: ["/../etc/passwd"] })).toThrow(/\.\./);
  });

  it("accepts an http(s) prototype URL and refuses anything else", () => {
    expect(parseCriteria({ prototypeUrl: " https://proto.test/a.html " }).prototypeUrl).toBe("https://proto.test/a.html");
    expect(parseCriteria({ prototypeUrl: "" }).prototypeUrl).toBeNull();
    expect(() => parseCriteria({ prototypeUrl: "file:///etc/passwd" })).toThrow(CriteriaError);
    expect(() => parseCriteria({ prototypeUrl: "not a url" })).toThrow(CriteriaError);
  });

  it("names the offending field so a 400 can be acted on", () => {
    try {
      parseCriteria({ tolerancePx: -1 });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as CriteriaError).field).toBe("tolerancePx");
    }
  });

  it("bounds every numeric field rather than trusting the form", () => {
    expect(() => parseCriteria({ tolerancePx: LIMITS.maxTolerancePx + 1 })).toThrow(/tolerancePx/);
    expect(() => parseCriteria({ maxLayoutDiffs: -5 })).toThrow(/maxLayoutDiffs/);
    expect(() => parseCriteria({ viewports: [{ width: 10, height: 900 }] })).toThrow(/width/);
    expect(() => parseCriteria({ viewports: [{ width: 1512, height: 10 }] })).toThrow(/height/);
    expect(() => parseCriteria({ viewports: [] })).toThrow(/non-empty/);
    expect(() =>
      parseCriteria({ viewports: Array.from({ length: LIMITS.maxViewports + 1 }, () => ({ width: 1280, height: 800 })) }),
    ).toThrow(/at most/);
  });

  it("rounds viewport values so a fractional width cannot reach the browser", () => {
    expect(parseCriteria({ viewports: [{ width: 1512.6, height: 949.4 }] }).viewports).toEqual([{ width: 1513, height: 949 }]);
  });

  it("drops blank content entries and refuses an oversized one", () => {
    expect(parseCriteria({ requiredContent: ["Acme", "  ", "Acme"] }).requiredContent).toEqual(["Acme"]);
    expect(() => parseCriteria({ requiredContent: ["x".repeat(LIMITS.maxContentLength + 1)] })).toThrow(/characters/);
  });
});

describe("criteriaCompleteness", () => {
  it("scores a bare intake low and a fully specified one at 1", () => {
    expect(criteriaCompleteness(parseCriteria({ requireFontParity: false }))).toBeLessThan(0.5);
    expect(
      criteriaCompleteness(
        parseCriteria({
          prototypeUrl: "https://proto.test",
          requiredRoutes: ["/", "/about"],
          requiredContent: ["Acme"],
          requireFontParity: true,
        }),
      ),
    ).toBe(1);
  });
});
