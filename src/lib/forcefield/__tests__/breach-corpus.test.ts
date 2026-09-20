/**
 * The famous-breach corpus must (a) actually stop what it says it stops, driven
 * through the real defenses, and (b) be HONEST - the out-of-scope classes are
 * classified out_of_scope, not dressed up as coverage.
 */
import { runBreachCorpus, type Coverage } from "@/lib/forcefield/breach-corpus";

describe("famous-breach corpus", () => {
  it("classifies each documented technique with the honest coverage it earns", async () => {
    const report = await runBreachCorpus();
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r.coverage])) as Record<string, Coverage>;
    expect(byId["fake-crawler"]).toBe("detected");
    expect(byId["mass-scraping"]).toBe("prevented");
    expect(byId["idor-enumeration"]).toBe("detected");
    expect(byId["injection"]).toBe("detected");
    expect(byId["credential-stuffing"]).toBe("detected");
    expect(byId["token-replay"]).toBe("prevented");
    expect(byId["token-overreach"]).toBe("prevented");
    expect(byId["forged-auth"]).toBe("prevented");
    // honesty: we do NOT claim to stop these
    expect(byId["supply-chain"]).toBe("out_of_scope");
    expect(byId["authorized-insider"]).toBe("out_of_scope");
  });

  it("prevents 4, detects 4, and is honest about 2 out-of-scope classes", async () => {
    const r = await runBreachCorpus();
    expect(r.prevented).toBe(4);
    expect(r.detected).toBe(4);
    expect(r.outOfScope).toBe(2);
    expect(r.total).toBe(10);
  });

  it("every entry cites a real-world technique and names its control", async () => {
    for (const r of (await runBreachCorpus()).results) {
      expect(r.realWorld.length).toBeGreaterThan(15);
      expect(r.control.length).toBeGreaterThan(15);
      expect(r.attack.length).toBeGreaterThan(15);
    }
  });
});
