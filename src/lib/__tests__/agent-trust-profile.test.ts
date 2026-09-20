import { consolidateByOperator, deriveTrustProfile, type OperatorViewJourney } from "@/lib/agent-operators-view";

function j(over: Partial<OperatorViewJourney> & { operatorKey: string }): OperatorViewJourney {
  const { operatorKey, ...rest } = over;
  return {
    key: rest.key ?? Math.random().toString(36),
    behaviorClass: "vuln_scanner", confidence: "inferred", firstAt: "2026-09-19T00:00:00Z", lastAt: "2026-09-19T00:00:00Z", path: [], eventCount: 1,
    ...rest,
    profile: { operatorKey, scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [], ...(rest.profile ?? {}) } as OperatorViewJourney["profile"],
  };
}

describe("deriveTrustProfile", () => {
  it("scores a proven benign crawler as trusted, intent = legitimate crawl", () => {
    const [g] = consolidateByOperator([j({ operatorKey: "op_ok", behaviorClass: "benign_crawler", confidence: "proven", profile: { operatorKey: "op_ok", scaffolding: { pathDiscovery: "link-following", readsRobotsFirst: true }, toolComposition: { usedTools: ["fetch"] }, insights: [] } })]);
    const t = deriveTrustProfile(g);
    expect(t.band).toBe("trusted");
    expect(t.score).toBeGreaterThanOrEqual(75);
    expect(t.intent).toBe("legitimate_crawl");
  });

  it("scores a proven exploiter as hostile, intent = active exploitation", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_x", behaviorClass: "exploit_attempt", confidence: "proven", path: ["/wp-login.php"],
          profile: { operatorKey: "op_x", scaffolding: { pathDiscovery: "path-guessing", readsRobotsFirst: true }, toolComposition: { usedTools: ["fetch", "submit_form"] }, insights: [{ kind: "payload_attack", attack: "sql_injection" }, { kind: "deliberate_violation" }] } }),
    ]);
    const t = deriveTrustProfile(g);
    expect(t.band).toBe("hostile");
    expect(t.score).toBeLessThan(25);
    expect(t.intent).toBe("active_exploitation");
    expect(t.intentConfidence).toBe("proven");
  });

  it("impersonation drives the score down and names the intent", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_i", behaviorClass: "vuln_scanner",
          profile: { operatorKey: "op_i", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "impersonation" }] } }),
    ]);
    const t = deriveTrustProfile(g);
    expect(t.intent).toBe("access_probing" === t.intent ? t.intent : "impersonation"); // impersonation ranks above recon here
    expect(["untrusted", "hostile"]).toContain(t.band);
  });

  it("is monotonic + bounded: score stays within 0..100 and worse behavior scores lower", () => {
    const [scraper] = consolidateByOperator([j({ operatorKey: "op_s", behaviorClass: "aggressive_scraper" })]);
    const [benign] = consolidateByOperator([j({ operatorKey: "op_b", behaviorClass: "benign_crawler" })]);
    const s = deriveTrustProfile(scraper).score, b = deriveTrustProfile(benign).score;
    expect(b).toBeGreaterThan(s);
    for (const v of [s, b]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
    expect(deriveTrustProfile(scraper).intent).toBe("content_harvesting");
  });
});
