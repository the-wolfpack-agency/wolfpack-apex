/** @jest-environment node */
import { crossSiteFootprint, cadenceSignature, adaptiveReaction, clientClass, analyzeAgent, type AgentIntelEvent } from "../agent-intelligence";

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
    expect(clientClass([ev({ clientType: "headless_chrome", tool: "HeadlessChrome" })]).clientClass).toBe("automation_framework");
  });
  it("names a dumb script", () => {
    expect(clientClass([ev({ tool: "python-requests" })]).clientClass).toBe("script");
  });
  it("names a browser / known crawler", () => {
    expect(clientClass([ev({ clientType: "known_crawler" })]).clientClass).toBe("browser");
  });
});

describe("analyzeAgent", () => {
  it("fuses all four lenses", () => {
    const r = analyzeAgent([
      ev({ site: "ogiam.com", at: "2026-09-24T10:00:00Z" }),
      ev({ site: "instinct", tool: "HeadlessChrome", clientType: "headless_chrome", blocked: true, at: "2026-09-24T10:00:05Z", signals: ["tripped_decoy"] }),
    ]);
    expect(r.crossSite.campaign).toBe(true);
    expect(r.client.clientClass).toBe("automation_framework");
    expect(r.adaptive.reaction).toBe("gave_up"); // the block was the last thing it did
    expect(r.cadence).toBeDefined();
  });
});
