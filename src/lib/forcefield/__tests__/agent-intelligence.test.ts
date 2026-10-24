/** @jest-environment node */
import { crossSiteFootprint, cadenceSignature, adaptiveReaction, clientClass, analyzeAgent, AI_AGENT_IDS, CLIENT_TYPE_CLASS, isAiAgentId, type AgentIntelEvent } from "../agent-intelligence";
import { classifyClient, DEFAULT_TOOL_SIGNATURES } from "@/lib/forcefield-web/fingerprint";
import { observeRequest } from "@/lib/forcefield-web/observe";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const ev = (o: Partial<AgentIntelEvent>): AgentIntelEvent => ({ at: "2026-09-24T10:00:00Z", site: "instinct", blocked: false, ...o });

describe("crossSiteFootprint", () => {
  it("flags an operator active on multiple properties as a campaign", () => {
    const r = crossSiteFootprint([ev({ site: "instinct" }), ev({ site: "ogiam.com" }), ev({ site: "instinct" })]);
    expect(r.sites).toEqual(["instinct", "ogiam.com"]);
    expect(r.siteCount).toBe(2);
    expect(r.campaign).toBe(true);
  });
  it("single-site operator is not a campaign", () => {
    expect(crossSiteFootprint([ev({ site: "instinct" }), ev({ site: "instinct" })]).campaign).toBe(false);
  });
});

describe("cadenceSignature", () => {
  it("reads metronomic timing as machine-regular / automated", () => {
    const evs = [0, 5, 10, 15, 20].map((s) => ev({ at: new Date(Date.parse("2026-09-24T10:00:00Z") + s * 1000).toISOString() }));
    const r = cadenceSignature(evs);
    expect(r.rhythm).toBe("machine_regular");
    expect(r.automated).toBe(true);
    expect(r.medianGapSec).toBe(5);
  });
  it("reads sub-second bursts as bursty / automated", () => {
    const evs = [0, 0.2, 0.4, 0.5].map((s) => ev({ at: new Date(Date.parse("2026-09-24T10:00:00Z") + s * 1000).toISOString() }));
    expect(cadenceSignature(evs).automated).toBe(true);
  });
  it("reads irregular, human-paced timing as human-like", () => {
    const evs = [0, 4, 30, 33, 90].map((s) => ev({ at: new Date(Date.parse("2026-09-24T10:00:00Z") + s * 1000).toISOString() }));
    const r = cadenceSignature(evs);
    expect(r.rhythm).toBe("human_like");
    expect(r.automated).toBe(false);
  });
  it("a single request has no rhythm", () => {
    expect(cadenceSignature([ev({})]).rhythm).toBe("single");
  });
});

describe("adaptiveReaction", () => {
  it("none when never blocked", () => {
    expect(adaptiveReaction([ev({ blocked: false })]).reaction).toBe("none");
  });
  it("gave_up when nothing follows the block", () => {
    expect(adaptiveReaction([ev({ at: "2026-09-24T10:00:00Z" }), ev({ at: "2026-09-24T10:00:01Z", blocked: true })]).reaction).toBe("gave_up");
  });
  it("persisted when it keeps going after a block", () => {
    const r = adaptiveReaction([
      ev({ at: "2026-09-24T10:00:00Z", blocked: true, signals: ["probed_sensitive"] }),
      ev({ at: "2026-09-24T10:00:05Z", signals: ["probed_sensitive"] }),
    ]);
    expect(r.reaction).toBe("persisted");
    expect(r.eventsAfterBlock).toBe(1);
  });
  it("escalated when a NEW hostile signal appears after the block", () => {
    const r = adaptiveReaction([
      ev({ at: "2026-09-24T10:00:00Z", blocked: true, signals: ["probed_sensitive"] }),
      ev({ at: "2026-09-24T10:00:05Z", signals: ["payload_attack"] }),
    ]);
    expect(r.reaction).toBe("escalated");
  });
});

describe("clientClass", () => {
  it("names an identified AI crawler", () => {
    expect(clientClass([ev({ tool: "GPTBot" })]).clientClass).toBe("ai_agent");
  });
  it("infers an AI agent from read-rules-then-target exploration", () => {
    expect(clientClass([ev({ signals: ["read_robots"] }), ev({ signals: ["probed_sensitive"] })]).clientClass).toBe("ai_agent");
  });
  it("names a headless automation framework", () => {
    expect(clientClass([ev({ clientType: "headless", tool: "HeadlessChrome" })]).clientClass).toBe("automation_framework");
  });
  it("names a dumb script", () => {
    expect(clientClass([ev({ tool: "python-requests" })]).clientClass).toBe("script");
  });
  it("names a known crawler as a crawler, and a browser as a browser", () => {
    expect(clientClass([ev({ clientType: "known_crawler" })]).clientClass).toBe("crawler");
    expect(clientClass([ev({ clientType: "browser" })]).clientClass).toBe("browser");
  });
});

describe("analyzeAgent", () => {
  it("fuses all four lenses", () => {
    const r = analyzeAgent([
      ev({ site: "ogiam.com", at: "2026-09-24T10:00:00Z" }),
      ev({ site: "instinct", tool: "HeadlessChrome", clientType: "headless", blocked: true, at: "2026-09-24T10:00:05Z", signals: ["tripped_decoy"] }),
    ]);
    expect(r.crossSite.campaign).toBe(true);
    expect(r.client.clientClass).toBe("automation_framework");
    expect(r.adaptive.reaction).toBe("gave_up"); // the block was the last thing it did
    expect(r.cadence).toBeDefined();
  });
});

// DRIFT GUARD: every label the classifier keys on is derived from what the engine
// actually emits (fingerprint.ts signatures, observe.ts props, the ruleset's
// agent ids), so a renamed label fails here instead of silently reading "unknown".
describe("clientClass labels match what observe/fingerprint emit", () => {
  const BROWSER_HEADERS = ["accept", "accept-language", "accept-encoding"];

  it("every bundled tool signature, as emitted, lands in its own class (never unknown)", () => {
    for (const [display, marker, type] of DEFAULT_TOOL_SIGNATURES) {
      const fp = classifyClient(`agent ${marker} 1.0`, []);
      expect(fp.tool).toBe(display);
      expect(fp.clientType).toBe(type);
      const r = clientClass([ev({ tool: fp.tool, clientType: fp.clientType })]);
      expect(r.clientClass).toBe(CLIENT_TYPE_CLASS[type]);
      expect(r.clientClass).not.toBe("unknown");
    }
  });

  it("the tool name alone (no client_type, as on legacy rows) still classifies", () => {
    for (const [display, , type] of DEFAULT_TOOL_SIGNATURES) {
      expect(clientClass([ev({ tool: display })]).clientClass).toBe(CLIENT_TYPE_CLASS[type]);
    }
  });

  it("the props observeRequest actually stamps classify the headless browser as automation", () => {
    const obs = observeRequest(
      { site: "s", path: "/pricing", method: "GET", userAgent: "Mozilla/5.0 HeadlessChrome/120", country: "US", headerNames: BROWSER_HEADERS, nowMs: 0 },
      DEFAULT_RULESET,
    );
    expect(obs?.props.client_type).toBe("headless");
    const r = clientClass([ev({ tool: String(obs?.props.tool), clientType: String(obs?.props.client_type) })]);
    expect(r.clientClass).toBe("automation_framework");
  });

  it("the agent id observeRequest stamps for every AI agent in the default ruleset reads ai_agent", () => {
    const aiIds = DEFAULT_RULESET.knownAgents.filter((a) => isAiAgentId(a.id));
    expect(aiIds.length).toBeGreaterThan(0);
    for (const a of aiIds) {
      const obs = observeRequest(
        { site: "s", path: "/", method: "GET", userAgent: `Mozilla/5.0 (compatible; ${a.uaMatch}/1.0)`, country: "US", headerNames: [], nowMs: 0 },
        DEFAULT_RULESET,
      );
      expect(obs?.type).toBe("site.agent_welcomed");
      const r = clientClass([ev({ agent: String(obs?.props.agent), clientType: String(obs?.props.client_type) })]);
      expect(r.clientClass).toBe("ai_agent");
    }
  });

  it("a non-AI search crawler from the ruleset is a crawler, not an AI agent", () => {
    const obs = observeRequest(
      { site: "s", path: "/", method: "GET", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)", country: "US", headerNames: [], nowMs: 0 },
      DEFAULT_RULESET,
    );
    expect(clientClass([ev({ agent: String(obs?.props.agent), clientType: String(obs?.props.client_type) })]).clientClass).toBe("crawler");
  });

  it("covers the AI agents seen this year by id", () => {
    for (const id of ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "MistralAI-User", "Meta-ExternalAgent"]) {
      expect(AI_AGENT_IDS).toContain(id);
      expect(clientClass([ev({ agent: id })]).clientClass).toBe("ai_agent");
    }
    expect(isAiAgentId("gptbot")).toBe(true); // case-insensitive
    expect(isAiAgentId("unidentified")).toBe(false); // observe's no-match placeholder
  });
});

describe("clientClass identity signals", () => {
  it("an impersonating claim is hostile automation, never an AI agent", () => {
    const r = clientClass([ev({ agent: "GPTBot", impersonating: "GPTBot", agentVerification: "impersonation", tool: "python-requests" })]);
    expect(r.clientClass).toBe("impersonator");
    expect(r.why).toMatch(/GPTBot/);
  });
  it("agent_verification=impersonation alone is enough", () => {
    expect(clientClass([ev({ agent: "ClaudeBot", agentVerification: "impersonation" })]).clientClass).toBe("impersonator");
  });
  it("a verified AI agent says so; an unverifiable one says it was not verified", () => {
    expect(clientClass([ev({ agent: "GPTBot", agentVerification: "verified" })]).why).toMatch(/verified/i);
    expect(clientClass([ev({ agent: "Claude-User", agentVerification: "unverifiable" })]).why).toMatch(/not independently verified/i);
  });
  it("a signed agent with no allowlisted id is still an AI agent", () => {
    expect(clientClass([ev({ signedAgent: true })]).clientClass).toBe("ai_agent");
  });
  it("names a scanner (previously fell through to unknown)", () => {
    expect(clientClass([ev({ clientType: "scanner", tool: "sqlmap" })]).clientClass).toBe("scanner");
  });
});
