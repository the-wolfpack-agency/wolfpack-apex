/**
 * Attribution dossier - fuses journey + scaffolding + tool-composition into one
 * operator-keyed evidence bundle, with the proven/inferred rail and the honest
 * "not a real-world identity" disclaimer on every dossier.
 */
import { buildDossier, buildDossiers, operatorKeyFor, type Sighting } from "@/lib/agent-dossier";
import type { AgentJourney } from "@/lib/agent-behavior";
import type { ScaffoldingSignature } from "@/lib/agent-probe";
import type { ToolCompositionReport } from "@/lib/agent-tool-composition";

const journey = (behaviorClass: string, confidence: "proven" | "inferred", path: string[] = []): AgentJourney => ({
  key: "k", confidence, behaviorClass: behaviorClass as AgentJourney["behaviorClass"], signals: [], path, steps: [],
  eventCount: path.length, firstAt: "t", lastAt: "t", summary: "s", insights: [],
});
const scaff = (over: Partial<ScaffoldingSignature> = {}): ScaffoldingSignature => ({
  stepCount: 3, readsRobotsFirst: false, followedLinks: 0, guessedPaths: 2, pathDiscovery: "path-guessing",
  retries: false, probedSensitive: true, ...over,
});
const tools = (over: Partial<ToolCompositionReport> = {}): ToolCompositionReport => ({
  usedTools: ["fetch"], novelTools: [], policies: [], maliciousCombinations: [], riskTier: "benign",
  intent: "benign", confidence: "none", summary: "s", ...over,
});
const sighting = (surface: string, at: string, j: AgentJourney, sc: ScaffoldingSignature, t: ToolCompositionReport): Sighting =>
  ({ surface, at, journey: j, scaffolding: sc, tools: t });

it("every dossier carries the honest not-an-identity disclaimer", () => {
  const d = buildDossier([sighting("ogiam.com", "t1", journey("benign_crawler", "proven"), scaff(), tools())]);
  expect(d.disclaimer).toMatch(/does not establish a real-world identity/i);
});

it("aggregates the tradecraft tells (signals + insight kinds) across sightings", () => {
  const j1 = { ...journey("vuln_scanner", "proven", ["/", "/admin"]), signals: ["probed_sensitive", "tripped_decoy"] as AgentJourney["signals"] };
  const j2 = { ...journey("exploit_attempt", "proven", ["/api"]), signals: ["payload_attack"] as AgentJourney["signals"], insights: [{ kind: "payload_attack", attack: "sqli", detail: "d" }] as AgentJourney["insights"] };
  const d = buildDossier([
    sighting("ogiam.com", "t1", j1, scaff(), tools()),
    sighting("ogiam.com", "t2", j2, scaff(), tools()),
  ]);
  // deduped + sorted union of every signal and insight kind observed
  expect(d.tells).toEqual(["payload_attack", "probed_sensitive", "tripped_decoy"]);
});

it("a proven hostile behavior makes the dossier proven-hostile", () => {
  const d = buildDossier([sighting("ogiam.com", "t1", journey("vuln_scanner", "proven", ["/", "/admin"]), scaff(), tools())]);
  expect(d.threatLevel).toBe("hostile");
  expect(d.confidence).toBe("proven");
});

it("an exercised malicious tool combo makes it proven-hostile with that intent", () => {
  const t = tools({ riskTier: "dangerous", confidence: "proven", intent: "credential_stuffing", maliciousCombinations: [{ tools: ["auth_attempt", "credential_list"], intent: "credential_stuffing", why: "w" }], policies: ["credential-abuse"] });
  const d = buildDossier([sighting("ogiam.com", "t1", journey("suspicious", "inferred"), scaff(), t)]);
  expect(d.threatLevel).toBe("hostile");
  expect(d.confidence).toBe("proven");
  expect(d.intent).toBe("credential_stuffing");
  expect(d.policies).toContain("credential-abuse");
});

it("dangerous capability with no exercised combo is ELEVATED and inferred", () => {
  const t = tools({ riskTier: "dangerous", confidence: "inferred", intent: "elevated_capability" });
  const d = buildDossier([sighting("ogiam.com", "t1", journey("suspicious", "inferred"), scaff(), t)]);
  expect(d.threatLevel).toBe("elevated");
  expect(d.confidence).toBe("inferred");
});

it("correlates one operator across surfaces via the durable operator key", () => {
  // Same scaffolding + toolset on two sites => one operator.
  const sc = scaff(), t = tools({ usedTools: ["fetch", "scrape_bulk"] });
  const d = buildDossier([
    sighting("ogiam.com", "t1", journey("aggressive_scraper", "proven", ["/_ff/x"]), sc, t),
    sighting("client-site.com", "t2", journey("aggressive_scraper", "proven", ["/_ff/y"]), sc, t),
  ]);
  expect(d.surfaces).toEqual(["ogiam.com", "client-site.com"]);
  expect(d.sightingCount).toBe(2);
  expect(d.operatorKey).toBe(operatorKeyFor(sc, t));
});

it("buildDossiers clusters mixed sightings into per-operator dossiers", () => {
  const opA = { sc: scaff({ pathDiscovery: "path-guessing" }), t: tools({ usedTools: ["fetch", "auth_attempt"] }) };
  const opB = { sc: scaff({ pathDiscovery: "link-following" }), t: tools({ usedTools: ["fetch"] }) };
  const ds = buildDossiers([
    sighting("s1", "t1", journey("vuln_scanner", "proven"), opA.sc, opA.t),
    sighting("s2", "t3", journey("benign_crawler", "proven"), opB.sc, opB.t),
    sighting("s3", "t2", journey("vuln_scanner", "proven"), opA.sc, opA.t),
  ]);
  expect(ds).toHaveLength(2); // two distinct operators
  const a = ds.find((d) => d.operatorKey === operatorKeyFor(opA.sc, opA.t))!;
  expect(a.sightingCount).toBe(2);
});

describe("operatorKeyFor - UA client tool folds into the fingerprint", () => {
  it("distinct client tools yield distinct operator keys (python-requests != sqlmap)", () => {
    const a = operatorKeyFor(scaff({ clientTool: "python-requests", clientType: "scripted_library" }), tools());
    const b = operatorKeyFor(scaff({ clientTool: "sqlmap", clientType: "scanner" }), tools());
    const c = operatorKeyFor(scaff({ clientTool: "HeadlessChrome", clientType: "headless" }), tools());
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("the same client tool yields the same key (correlates that tool across sites)", () => {
    expect(operatorKeyFor(scaff({ clientTool: "sqlmap", clientType: "scanner" }), tools()))
      .toBe(operatorKeyFor(scaff({ clientTool: "sqlmap", clientType: "scanner" }), tools()));
  });

  it("is backward-compatible: no client tool leaves the base fingerprint unchanged", () => {
    // A scaffolding with no client fields must key exactly as one with explicit
    // undefined - i.e. legacy (no-tool) events keep their existing operator key.
    expect(operatorKeyFor(scaff(), tools()))
      .toBe(operatorKeyFor(scaff({ clientTool: undefined, clientType: undefined }), tools()));
  });
});
