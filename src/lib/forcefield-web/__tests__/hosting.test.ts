/** @jest-environment node */
import { classifyHosting, DATACENTER_SEED, ipv4ToInt, ipInPrefix, parseCidr } from "../hosting";

describe("hosting classifier (portable edge core)", () => {
  it("has a non-trivial embedded seed of big cloud blocks", () => {
    expect(DATACENTER_SEED.length).toBeGreaterThan(50);
    for (const p of DATACENTER_SEED) { expect(p.bits).toBeLessThanOrEqual(16); expect(Number.isFinite(p.base)).toBe(true); }
  });
  it("classifies a real GCP compute IP as datacenter via the seed", () => {
    expect(classifyHosting("34.64.4.1", DATACENTER_SEED)).toBe("datacenter");
  });
  it("classifies a residential IP as residential", () => {
    expect(classifyHosting("24.60.1.1", DATACENTER_SEED)).toBe("residential");
  });
  it("never guesses on missing / malformed / IPv6", () => {
    expect(classifyHosting(null, DATACENTER_SEED)).toBe("unknown");
    expect(classifyHosting("2001:db8::1", DATACENTER_SEED)).toBe("unknown");
  });
  it("prefix math is correct", () => {
    const p = parseCidr("34.64.0.0/10")!;
    expect(ipInPrefix(ipv4ToInt("34.64.4.1")!, p)).toBe(true);
    expect(ipInPrefix(ipv4ToInt("35.0.0.1")!, p)).toBe(false);
  });
});

import { datacenterPrefixesFrom, _resetHostingCache, DATACENTER_SEED as SEED2 } from "../hosting";
describe("datacenterPrefixesFrom (ruleset distribution = united rollout)", () => {
  beforeEach(() => _resetHostingCache());
  it("uses the ruleset's full set (compact base/bits) over the bundled seed", () => {
    // 34.64.0.0/10 = base 574619648 -> covers 34.64.4.1
    const p = datacenterPrefixesFrom(["574619648/10"]);
    expect(classifyHosting("34.64.4.1", p)).toBe("datacenter");
    expect(classifyHosting("8.8.8.8", p)).toBe("residential"); // not in the ruleset set
  });
  it("falls back to the bundled seed when the ruleset carries none", () => {
    expect(datacenterPrefixesFrom(undefined)).toBe(SEED2);
    expect(datacenterPrefixesFrom([])).toBe(SEED2);
  });
  it("falls back to the seed when every ruleset entry is malformed (never worse off)", () => {
    expect(datacenterPrefixesFrom(["garbage", "x/y"])).toBe(SEED2);
  });
});

import { verifyAgentByRanges } from "../hosting";

describe("verifyAgentByRanges - crawler identity by the vendor's published ranges", () => {
  const compact = (cidr: string) => { const p = parseCidr(cidr)!; return `${p.base >>> 0}/${p.bits}`; };
  const ranges = { Googlebot: [compact("66.249.64.0/19")], GPTBot: [] as string[] };

  it("verified: claimed agent from inside its published range", () => {
    expect(verifyAgentByRanges("Googlebot", "66.249.66.1", ranges)).toBe("verified");
  });
  it("impersonation: claimed agent from outside its published range", () => {
    expect(verifyAgentByRanges("Googlebot", "203.0.113.9", ranges)).toBe("impersonation");
  });
  it("unverifiable: vendor publishes nothing, an empty list, no IP, or IPv6 - never an impersonation", () => {
    expect(verifyAgentByRanges("Amazonbot", "203.0.113.9", ranges)).toBe("unverifiable");
    expect(verifyAgentByRanges("GPTBot", "203.0.113.9", ranges)).toBe("unverifiable");
    expect(verifyAgentByRanges("Googlebot", undefined, ranges)).toBe("unverifiable");
    expect(verifyAgentByRanges("Googlebot", "2001:4860:4801::1", ranges)).toBe("unverifiable");
    expect(verifyAgentByRanges("Googlebot", "66.249.66.1", undefined)).toBe("unverifiable");
  });
  it("a wholly malformed list is unverifiable, not an impersonation (a bad refresh can't convict a crawler)", () => {
    expect(verifyAgentByRanges("Googlebot", "203.0.113.9", { Googlebot: ["garbage", "1.2.3.4"] })).toBe("unverifiable");
  });
});
