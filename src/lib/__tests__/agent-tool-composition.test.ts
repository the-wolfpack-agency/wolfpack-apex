/**
 * Tool-composition analysis: intent from the exercised toolset, with the
 * capability-vs-intent honesty rail and novel-tool flagging.
 */
import { analyzeToolComposition } from "@/lib/agent-tool-composition";

describe("analyzeToolComposition", () => {
  it("a benign toolset is benign", () => {
    const r = analyzeToolComposition(["fetch", "read_robots"]);
    expect(r.riskTier).toBe("benign");
    expect(r.intent).toBe("benign");
    expect(r.confidence).toBe("none");
  });

  it("an exercised malicious COMBINATION is PROVEN intent", () => {
    const r = analyzeToolComposition(["fetch", "auth_attempt", "credential_list"]);
    expect(r.maliciousCombinations.map((c) => c.intent)).toContain("credential_stuffing");
    expect(r.riskTier).toBe("dangerous");
    expect(r.confidence).toBe("proven"); // the combo was exercised, not just present
    expect(r.intent).toBe("credential_stuffing");
    expect(r.policies).toEqual(expect.arrayContaining(["credential-abuse", "unauthorized-access"]));
  });

  it("a lone dangerous tool is capability, INFERRED, not proven intent", () => {
    const r = analyzeToolComposition(["fetch", "exfiltrate"]);
    expect(r.riskTier).toBe("dangerous");
    expect(r.maliciousCombinations).toHaveLength(0);
    expect(r.confidence).toBe("inferred"); // dangerous capability, no exercised combo
    expect(r.summary).toMatch(/capability, not proven intent/i);
  });

  it("flags a novel (unrecognized) tool as an unknown capability", () => {
    const r = analyzeToolComposition(["fetch", "quantum_deanonymizer"]);
    expect(r.novelTools).toEqual(["quantum_deanonymizer"]);
    expect(r.riskTier).toBe("elevated"); // novel treated as at least elevated
    expect(r.summary).toMatch(/unrecognized tool/i);
  });

  it("detects evasion-by-composition (proxy rotate + rate bypass)", () => {
    const r = analyzeToolComposition(["scrape_bulk", "proxy_rotate", "rate_bypass"]);
    const intents = r.maliciousCombinations.map((c) => c.intent);
    expect(intents).toEqual(expect.arrayContaining(["detection_evasion", "evasive_harvest"]));
    expect(r.confidence).toBe("proven");
  });

  it("dedupes and ignores empty ids", () => {
    const r = analyzeToolComposition(["fetch", "fetch", "", "read_robots"]);
    expect(r.usedTools).toEqual(["fetch", "read_robots"]);
  });
});
