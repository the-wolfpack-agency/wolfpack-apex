/**
 * Access-control unit tests for the Invoice Tracker registry. This is the least-
 * privilege gate for finance/budget data, so the allowlist behaviour (exact,
 * case-insensitive, deny-empty) is the security-critical part and is covered
 * exhaustively.
 */
import {
  INVOICE_TRACKERS,
  getTracker,
  canViewTracker,
  trackersForViewer,
  shareUrlFor,
} from "../config";

const PCNA = INVOICE_TRACKERS.find((t) => t.id === "pcna")!;

describe("invoice-tracker config", () => {
  it("has the PCNA tracker with the three approved viewers on the Summary tab", () => {
    expect(PCNA).toBeDefined();
    expect(PCNA.company).toBe("PCNA");
    expect(PCNA.sheet).toBe("Summary");
    expect(PCNA.viewers).toEqual([
      "homyk@thewolfpack.agency",
      "nick@thewolfpack.agency",
      "jorge@thewolfpack.agency",
    ]);
  });

  describe("getTracker", () => {
    it("resolves by id case-insensitively and trims", () => {
      expect(getTracker("pcna")?.id).toBe("pcna");
      expect(getTracker("PCNA")?.id).toBe("pcna");
      expect(getTracker("  Pcna  ")?.id).toBe("pcna");
    });
    it("returns undefined for unknown / empty ids", () => {
      expect(getTracker("nope")).toBeUndefined();
      expect(getTracker("")).toBeUndefined();
      expect(getTracker(null)).toBeUndefined();
      expect(getTracker(undefined)).toBeUndefined();
    });
  });

  describe("canViewTracker", () => {
    it.each(PCNA.viewers)("allows approved viewer %s", (email) => {
      expect(canViewTracker(PCNA, email)).toBe(true);
    });
    it("is case-insensitive and whitespace-tolerant", () => {
      expect(canViewTracker(PCNA, "HOMYK@thewolfpack.agency")).toBe(true);
      expect(canViewTracker(PCNA, "  jorge@thewolfpack.agency ")).toBe(true);
    });
    it("denies non-listed emails", () => {
      expect(canViewTracker(PCNA, "intruder@thewolfpack.agency")).toBe(false);
      expect(canViewTracker(PCNA, "homyk@evil.example")).toBe(false);
    });
    it("denies empty / missing email (agent + on-behalf tokens resolve to '')", () => {
      expect(canViewTracker(PCNA, "")).toBe(false);
      expect(canViewTracker(PCNA, "   ")).toBe(false);
      expect(canViewTracker(PCNA, null)).toBe(false);
      expect(canViewTracker(PCNA, undefined)).toBe(false);
    });
  });

  describe("trackersForViewer", () => {
    it("returns PCNA for an approved viewer", () => {
      expect(trackersForViewer("nick@thewolfpack.agency").map((t) => t.id)).toEqual(["pcna"]);
    });
    it("returns nothing for a non-viewer or empty email", () => {
      expect(trackersForViewer("stranger@thewolfpack.agency")).toEqual([]);
      expect(trackersForViewer("")).toEqual([]);
      expect(trackersForViewer(null)).toEqual([]);
    });
  });

  describe("shareUrlFor", () => {
    const KEY = PCNA.shareUrlEnv;
    const original = process.env[KEY];
    afterEach(() => {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    });
    it("falls back to the checked-in default when the env var is unset", () => {
      delete process.env[KEY];
      expect(shareUrlFor(PCNA)).toBe(PCNA.defaultShareUrl);
    });
    it("prefers the env override when set", () => {
      process.env[KEY] = "https://example.test/rotated-link";
      expect(shareUrlFor(PCNA)).toBe("https://example.test/rotated-link");
    });
  });
});
