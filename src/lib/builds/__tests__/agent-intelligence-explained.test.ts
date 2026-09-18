/**
 * The Agent Intelligence explainer must not blur what is built with what is
 * coming, must carry the honesty rail in its copy, and must stay secret-safe.
 */
import { AGENT_INTEL_HEADLINE, AGENT_INTEL_SECTIONS, AGENT_INTEL_CLOSER } from "@/lib/builds/agent-intelligence-explained";
import { CLIENT_BUILDS } from "@/lib/builds/registry";

describe("Agent Intelligence explainer content", () => {
  it("covers the built capabilities plus the one roadmap section, in order", () => {
    expect(AGENT_INTEL_SECTIONS.map((s) => s.id)).toEqual([
      "welcome-lane", "following", "scaffolding", "tools", "dossier", "prove-it", "honest", "operators-over-time",
    ]);
  });

  it("flags EXACTLY the coming-next section as roadmap, and nothing built", () => {
    expect(AGENT_INTEL_SECTIONS.filter((s) => s.roadmap).map((s) => s.id)).toEqual(["operators-over-time"]);
    for (const s of AGENT_INTEL_SECTIONS) if (s.id !== "operators-over-time") expect(s.roadmap).toBeFalsy();
  });

  it("every section has plain-language body and a 'what this means' line (except the roadmap one)", () => {
    for (const s of AGENT_INTEL_SECTIONS) {
      expect(s.body.length).toBeGreaterThan(0);
      if (!s.roadmap) expect(typeof s.meaning).toBe("string");
    }
  });

  it("carries the honesty rail (proven vs likely) and the not-an-identity limit", () => {
    const all = [AGENT_INTEL_HEADLINE, AGENT_INTEL_CLOSER, ...AGENT_INTEL_SECTIONS.flatMap((s) => [...s.body, s.meaning ?? ""])].join(" ").toLowerCase();
    expect(all).toMatch(/proven/);
    expect(all).toMatch(/likely/);
    expect(all).toMatch(/does not claim a real-world identity|not.*real-world identity/);
  });

  it("is secret-safe: no trap paths, probe lists, or fingerprint mechanics", () => {
    const all = [AGENT_INTEL_HEADLINE, AGENT_INTEL_CLOSER, ...AGENT_INTEL_SECTIONS.flatMap((s) => [...s.body, s.meaning ?? ""])].join(" ");
    expect(all).not.toMatch(/\/_ff|\/\.env|\/wp-login|robots\.txt|fingerprint\(|sha256|fnv/i);
  });

  it("is registered in the builds registry", () => {
    expect(CLIENT_BUILDS.some((b) => b.href === "/builds/agent-intelligence")).toBe(true);
  });
});
