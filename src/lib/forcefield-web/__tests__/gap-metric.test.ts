/**
 * The gap metric is the number that makes the thesis defensible, so its
 * arithmetic is tested directly: prevention rate over the hostile subset, slips
 * carried with their input (so a gap is actionable), and false positives counted
 * separately. runGapCases is exercised against the REAL engine on a known-blocked
 * and a known-slipping case so the offline bridge is proven too.
 */
import { scoreGap, runGapCases, scoreGapForCases, type GapCase, type GapOutcome } from "../gap-metric";

describe("scoreGap (pure)", () => {
  const O = (name: string, intendedHostile: boolean, blocked: boolean): GapOutcome => ({ name, intendedHostile, blocked });

  it("prevention rate is over the HOSTILE subset only", () => {
    const s = scoreGap([
      O("a", true, true),
      O("b", true, true),
      O("c", true, false), // a slip
      O("d", false, false), // benign allowed (correct)
    ]);
    expect(s.hostile).toBe(3);
    expect(s.prevented).toBe(2);
    expect(s.slipped).toBe(1);
    expect(s.preventedPct).toBe(66.7);
    expect(s.slips.map((x) => x.name)).toEqual(["c"]);
  });

  it("a benign case that is blocked is a FALSE POSITIVE, not a prevention", () => {
    const s = scoreGap([O("real-user", false, true), O("attack", true, true)]);
    expect(s.falsePositives).toBe(1);
    expect(s.falsePositiveCases).toEqual(["real-user"]);
    expect(s.prevented).toBe(1); // only the hostile one counts as prevented
    expect(s.preventedPct).toBe(100);
  });

  it("no hostile cases -> preventedPct 100 (no gap to miss)", () => {
    expect(scoreGap([O("x", false, false)]).preventedPct).toBe(100);
  });

  it("all hostile slipped -> 0% prevented, every slip listed", () => {
    const s = scoreGap([O("a", true, false), O("b", true, false)]);
    expect(s.preventedPct).toBe(0);
    expect(s.slipped).toBe(2);
    expect(s.slips).toHaveLength(2);
  });

  it("carries the input through so a slip is actionable (what to rule)", () => {
    const input = { path: "/x", method: "GET", userAgent: "ua", headerNames: ["host"] };
    const s = scoreGap([{ name: "novel", intendedHostile: true, blocked: false, input }]);
    expect(s.slips[0].input).toEqual(input);
  });
});

describe("runGapCases + scoreGapForCases (real engine bridge)", () => {
  const hostileBlocked: GapCase = {
    name: "sqlmap UA",
    input: { path: "/", method: "GET", userAgent: "sqlmap/1.7.2#stable", headerNames: ["host", "user-agent"] },
    intendedHostile: true,
  };
  const benignAllowed: GapCase = {
    name: "real browser",
    input: { path: "/pricing", method: "GET", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", headerNames: ["host", "user-agent", "accept", "accept-language"] },
    intendedHostile: false,
  };

  it("runs cases through the real engine and reports the true block outcome", () => {
    const outcomes = runGapCases([hostileBlocked, benignAllowed]);
    expect(outcomes.find((o) => o.name === "sqlmap UA")?.blocked).toBe(true);
    expect(outcomes.find((o) => o.name === "real browser")?.blocked).toBe(false);
  });

  it("scoreGapForCases: a known attack is prevented, a real visitor is not a false positive", () => {
    const s = scoreGapForCases([hostileBlocked, benignAllowed]);
    expect(s.preventedPct).toBe(100);
    expect(s.falsePositives).toBe(0);
  });

  it("a hostile case the engine does NOT catch surfaces as a slip (an open gap)", () => {
    // A plain, unremarkable GET that carries no proven-hostile signal: the engine
    // correctly does NOT block it, so marking it hostile models an undetected attack.
    const undetected: GapCase = {
      name: "novel semantic abuse (no signature yet)",
      input: { path: "/account/export", method: "GET", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", headerNames: ["host", "user-agent", "accept"] },
      intendedHostile: true,
    };
    const s = scoreGapForCases([undetected]);
    expect(s.slipped).toBe(1);
    expect(s.preventedPct).toBe(0);
    expect(s.slips[0].name).toContain("novel semantic abuse");
  });
});
