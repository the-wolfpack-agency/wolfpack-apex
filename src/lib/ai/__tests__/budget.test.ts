/**
 * The budget governor.
 *
 * OpenRouter caps a key and fails the request with a 402. The failure mode of
 * a hard cap is not technical: it arrives at 4pm on a Thursday while somebody
 * is drafting a reply to a client, and the product stops. So caps get set high
 * enough never to fire, or they fire and somebody raises them in a hurry. A
 * control that people route around is not a control.
 *
 * These tests pin the alternative: capability degrades before service is
 * refused, the ceiling still exists so this is a real control, and the person
 * is told when they are getting a smaller model.
 */
import { governTier, WARN_FRACTION, CEILING_MULTIPLE } from "@/lib/ai/budget";

const at = (spentUsd: number, capUsd: number | null, requestedTier: "cheap" | "standard" | "premium" = "premium") =>
  governTier({ spentUsd, capUsd, requestedTier });

describe("under the warn line, nothing changes", () => {
  test("a premium question stays premium", () => {
    const d = at(50, 100);
    expect(d).toMatchObject({ state: "ok", tier: "premium", stop: false, reason: "within_budget" });
    // No note: a message on every turn is noise, and nothing happened.
    expect(d.notice).toBeNull();
  });

  test("no cap is not the same as an unlimited cap", () => {
    const d = at(9_999, null);
    expect(d).toMatchObject({ reason: "no_cap", tier: "premium", stop: false });
    // Nothing to draw, so no fraction rather than a misleading zero.
    expect(d.fraction).toBeNull();
  });
});

describe("approaching the cap, capability degrades before service does", () => {
  test("a premium question is served by a standard model", () => {
    const d = at(WARN_FRACTION * 100, 100, "premium");
    expect(d).toMatchObject({ state: "approaching", tier: "standard", stop: false });
    expect(d.notice).toMatch(/smaller model/i);
  });

  test("a cheap question is untouched, and says nothing", () => {
    /* Somebody asking something simple at 85% of the cap has lost nothing.
       Telling them about the budget anyway is noise. */
    const d = at(85, 100, "cheap");
    expect(d.tier).toBe("cheap");
    expect(d.notice).toBeNull();
  });
});

describe("over the cap, the product still works", () => {
  test("answers keep coming, from the smallest model, and say so", () => {
    const d = at(120, 100, "premium");
    expect(d).toMatchObject({ state: "over", tier: "cheap", stop: false, reason: "over_cap" });
    /* The honest part: a cheaper model gives a worse answer to a hard
       question, and the reader is entitled to know that is why. */
    expect(d.notice).toMatch(/shorter and less thorough/i);
  });

  test("this is the whole difference from a 402", () => {
    // The request is not refused. That is the design, not an oversight.
    expect(at(199, 100).stop).toBe(false);
  });
});

describe("the ceiling makes it a control rather than a suggestion", () => {
  test("a runaway workspace is stopped", () => {
    const d = at(CEILING_MULTIPLE * 100, 100);
    expect(d).toMatchObject({ state: "stopped", stop: true, reason: "hard_ceiling" });
    expect(d.notice).toMatch(/paused/i);
  });

  test("the ceiling is well above the cap, because a cap is a budget and a ceiling is an incident", () => {
    expect(CEILING_MULTIPLE).toBeGreaterThan(1);
    expect(at(100 * CEILING_MULTIPLE - 0.01, 100).stop).toBe(false);
  });
});

describe("a budget may restrict and may never escalate", () => {
  test("a cheap request is never raised to standard by being near the cap", () => {
    expect(at(85, 100, "cheap").tier).toBe("cheap");
  });

  test("nonsense input degrades safely rather than throwing", () => {
    expect(at(Number.NaN, 100).tier).toBe("premium");
    expect(at(50, Number.NaN).reason).toBe("no_cap");
    expect(at(50, -5).reason).toBe("no_cap");
    expect(at(-1, 100).state).toBe("ok");
  });
});
