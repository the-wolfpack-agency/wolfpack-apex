import { buildAgentProfile } from "@/lib/agent-profile";
import type { AgentJourney } from "@/lib/agent-behavior";

function journey(over: Partial<AgentJourney>): AgentJourney {
  return {
    key: "sig_abc",
    confidence: "inferred",
    behaviorClass: "suspicious",
    signals: [],
    path: [],
    eventCount: 1,
    firstAt: "2026-09-19T00:00:00Z",
    lastAt: "2026-09-19T00:00:00Z",
    summary: "",
    insights: [],
    ...over,
  };
}

describe("buildAgentProfile (honest, engine-reused)", () => {
  it("explains a proven decoy trip as structural proof and flags the hostile process", () => {
    const p = buildAgentProfile(journey({
      confidence: "proven", behaviorClass: "aggressive_scraper",
      signals: ["tripped_decoy"], path: ["/", "/_ff/records"], eventCount: 2,
      firstAt: "2026-09-19T00:00:00Z", lastAt: "2026-09-19T00:00:10Z",
    }));
    expect(p.verdict.confidence).toBe("proven");
    expect(p.verdict.why).toMatch(/invisible.*decoy|robots-disallowed/i);
    const decoy = p.processes.find((x) => x.signal === "tripped_decoy");
    expect(decoy?.hostile).toBe(true);
    expect(p.scaffolding.pathDiscovery).toBe("link-following");
    expect(p.timeline.spanSeconds).toBe(10);
    expect(p.operatorKey).toMatch(/^op_/);
    expect(p.disclaimer).toMatch(/does not establish a real-world identity/i);
  });

  it("reads a sensitive-path probe as path-guessing recon", () => {
    const p = buildAgentProfile(journey({
      behaviorClass: "vuln_scanner", signals: ["probed_sensitive"], path: ["/admin", "/.env"], eventCount: 2,
    }));
    expect(p.scaffolding.probedSensitive).toBe(true);
    expect(p.scaffolding.pathDiscovery).toBe("path-guessing");
    const proc = p.processes.find((x) => x.signal === "probed_sensitive");
    expect(proc?.hostile).toBe(true);
  });

  it("adds a form submitter to the honestly-observable toolset when a form signal is present", () => {
    const p = buildAgentProfile(journey({ confidence: "proven", behaviorClass: "form_spammer", signals: ["form_honeypot"], path: ["/login"] }));
    expect(p.toolComposition.usedTools).toContain("fetch");
    expect(p.toolComposition.usedTools).toContain("submit_form");
    expect(p.verdict.why).toMatch(/honeypot/i);
  });

  it("labels an inferred verdict as a likely-not-proven grouping and says what would upgrade it", () => {
    const p = buildAgentProfile(journey({ confidence: "inferred", signals: ["read_robots"], path: ["/robots.txt"] }));
    expect(p.verdict.confidence).toBe("inferred");
    expect(p.verdict.why).toMatch(/likely match, not proof|becomes proven/i);
    expect(p.scaffolding.readsRobotsFirst).toBe(true);
  });

  it("only ever lists fetch when no form or hostile tool signal is present (no invented tools)", () => {
    const p = buildAgentProfile(journey({ signals: ["read_robots", "read_sitemap"], path: ["/robots.txt", "/sitemap.xml"] }));
    expect(p.toolComposition.usedTools).toEqual(["fetch"]);
    expect(p.policies).toEqual([]);
  });

  it("is deterministic: same journey -> same operator key", () => {
    const j = journey({ signals: ["probed_sensitive"], path: ["/admin"] });
    expect(buildAgentProfile(j).operatorKey).toBe(buildAgentProfile(j).operatorKey);
  });
});
