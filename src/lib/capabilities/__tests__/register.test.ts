/**
 * A claim is not a capability until something has done it.
 *
 * WHAT THIS WAS BUILT AFTER. Four capabilities were built, tested, configured
 * in production, and had never run once: OCR, query expansion, the document
 * repair, and the retrieval eval. Every one was found by accident, weeks late,
 * while chasing something else. None failed loudly, because a capability
 * nothing exercises does not degrade. It simply never was, and the code reads
 * identically either way.
 */

import {
  CAPABILITIES,
  verdictFor,
  isFailing,
  describe as describeStatus,
  FRESH_DAYS,
  type CapabilityStatus,
} from "@/lib/capabilities/register";

const NOW = new Date("2026-09-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("turning an observation into a verdict", () => {
  it("calls a capability that has never run never, not merely stale", () => {
    expect(verdictFor(0, null, 1, NOW)).toBe("never");
  });

  it("calls a recent one demonstrated", () => {
    expect(verdictFor(28, daysAgo(1), 1, NOW)).toBe("demonstrated");
  });

  /* A February success does not make a claim true in September. */
  it("calls an old one stale rather than demonstrated", () => {
    expect(verdictFor(5, daysAgo(FRESH_DAYS + 1), 1, NOW)).toBe("stale");
    expect(verdictFor(5, daysAgo(FRESH_DAYS - 1), 1, NOW)).toBe("demonstrated");
  });

  /* THE DISTINCTION THE WHOLE REGISTER RESTS ON. An unreadable signal and an
     absent one lead to opposite actions: one is a broken check, the other is a
     broken product. */
  it("separates could-not-check from never-happened", () => {
    expect(verdictFor(null, null, 1, NOW)).toBe("unknown");
    expect(verdictFor(0, null, 1, NOW)).toBe("never");
  });

  /* Some capabilities need more than one observation to mean anything: one
     model used is not a router switching between models. */
  it("honors a threshold above one", () => {
    expect(verdictFor(1, daysAgo(1), 2, NOW)).toBe("never");
    expect(verdictFor(2, daysAgo(1), 2, NOW)).toBe("demonstrated");
  });

  it("only fails the job on never, so a quiet fortnight is not an alarm", () => {
    const s = (verdict: CapabilityStatus["verdict"]): CapabilityStatus => ({
      capability: CAPABILITIES[0],
      verdict,
      observations: 0,
      lastSeen: null,
    });
    expect(isFailing(s("never"))).toBe(true);
    expect(isFailing(s("stale"))).toBe(false);
    expect(isFailing(s("demonstrated"))).toBe(false);
    /* Unknown does not fail either: a broken check should not read as a broken
       product, and it shows on the page as its own verdict. */
    expect(isFailing(s("unknown"))).toBe(false);
  });
});

describe("the register itself", () => {
  /* SUCCESS SIGNALS ONLY. A degradation event never firing is good news, so it
     can never be evidence that something works. A register built on those
     would read worst when the product is healthiest. */
  it("proves capabilities by things that happen when they work", () => {
    for (const c of CAPABILITIES) {
      const name = c.provenBy.kind === "event" ? c.provenBy.event : c.provenBy.label;
      expect(name).not.toMatch(/degraded|failed|error|refused|unavailable/i);
    }
  });

  /* THE MISTAKE THIS REGISTER MADE ABOUT ITSELF. document_repair first proved
     itself with brain.reprocess_run, which fires whether a run repaired fifty
     documents or none. The job had been emitting it nightly for weeks while
     repairing nothing, so the register would have called it demonstrated and
     been wrong in exactly the way the job was. */
  it("does not prove the repair by a run merely having happened", () => {
    const repair = CAPABILITIES.find((c) => c.id === "document_repair")!;
    const name = repair.provenBy.kind === "event" ? repair.provenBy.event : repair.provenBy.label;
    expect(name).not.toBe("brain.reprocess_run");
    expect(name).toMatch(/repaired/i);
  });

  it("says why each one matters, for whoever reads the failing job", () => {
    for (const c of CAPABILITIES) {
      expect(c.claim.length).toBeGreaterThan(30);
      /* Long enough to carry a reason rather than a restatement. */
      expect(c.matters.length).toBeGreaterThan(60);
    }
  });

  it("has no duplicate ids", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prints a line naming the verdict, the claim and the stake", () => {
    const line = describeStatus({
      capability: CAPABILITIES.find((c) => c.id === "ocr")!,
      verdict: "never",
      observations: 0,
      lastSeen: null,
    });
    expect(line).toMatch(/NEVER/);
    expect(line).toMatch(/never once/);
    expect(line).toMatch(/scanned document/i);
  });
});
