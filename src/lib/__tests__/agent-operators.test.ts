/** @jest-environment node */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordSighting, listSightings, getOperators } from "@/lib/agent-operators";
import { operatorKeyFor, type Sighting } from "@/lib/agent-dossier";

const journey = (behaviorClass: string, confidence: "proven" | "inferred") => ({ key: "k", confidence, behaviorClass, signals: [], path: ["/", "/admin"], eventCount: 2, firstAt: "t", lastAt: "t", summary: "s" }) as never;
const scaff = (over = {}) => ({ stepCount: 2, readsRobotsFirst: false, followedLinks: 0, guessedPaths: 2, pathDiscovery: "path-guessing", retries: false, probedSensitive: true, ...over }) as never;
const tools = (over = {}) => ({ usedTools: ["fetch"], novelTools: [], policies: [], maliciousCombinations: [], riskTier: "benign", intent: "benign", confidence: "none", summary: "s", ...over }) as never;
const sighting = (surface: string, at: string): Sighting => ({ surface, at, journey: journey("vuln_scanner", "proven"), scaffolding: scaff(), tools: tools() });

const ORIG = process.env.DATABASE_URL;
beforeEach(() => { jest.clearAllMocks(); process.env.DATABASE_URL = "postgres://x"; });
afterEach(() => { if (ORIG === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = ORIG; });

it("recordSighting writes the row keyed by the durable operator fingerprint", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  const s = sighting("ogiam.com", "2026-09-18T10:00:00Z");
  const key = await recordSighting({ workspaceId: "w1", sighting: s });
  expect(key).toBe(operatorKeyFor(s.scaffolding, s.tools));
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_agent_sightings/);
  expect(params[1]).toBe(key); // operator_key
  expect(params[0]).toBe("w1"); // workspace scope
});

it("recordSighting is a no-op (no throw) without a database", async () => {
  delete process.env.DATABASE_URL;
  await expect(recordSighting({ workspaceId: "w1", sighting: sighting("s", "t") })).resolves.toBeTruthy();
  expect(mockQuery).not.toHaveBeenCalled();
});

it("getOperators reads stored sightings and groups them into per-operator dossiers", async () => {
  const s1 = sighting("ogiam.com", "2026-09-18T10:00:00Z");
  const s2 = sighting("client.com", "2026-09-18T11:00:00Z"); // same fingerprint -> one operator
  mockSafeQuery.mockResolvedValue({ rows: [
    { surface: s2.surface, seen_at: s2.at, journey: s2.journey, scaffolding: s2.scaffolding, tools: s2.tools },
    { surface: s1.surface, seen_at: s1.at, journey: s1.journey, scaffolding: s1.scaffolding, tools: s1.tools },
  ], fromCache: false });
  const operators = await getOperators("w1", 30);
  expect(operators).toHaveLength(1);
  expect(operators[0].surfaces).toEqual(expect.arrayContaining(["ogiam.com", "client.com"]));
  expect(operators[0].threatLevel).toBe("hostile");
  // scoped to the workspace
  expect(mockSafeQuery.mock.calls[0][1][0]).toBe("w1");
});

it("END TO END (stateful in-memory table): 3 sightings, 2 operators, board groups + ranks", async () => {
  // A real round-trip: INSERTs land in a table, the SELECT reads it back.
  const table: Array<Record<string, unknown>> = [];
  mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    table.push({
      workspace_id: params[0], operator_key: params[1], surface: params[2], seen_at: params[3],
      journey: JSON.parse(params[7] as string), scaffolding: JSON.parse(params[8] as string), tools: JSON.parse(params[9] as string),
    });
    return { rows: [] };
  });
  mockSafeQuery.mockImplementation(async (_sql: string, params: unknown[]) => ({
    rows: table.filter((r) => r.workspace_id === params[0]).map((r) => ({ surface: r.surface, seen_at: r.seen_at, journey: r.journey, scaffolding: r.scaffolding, tools: r.tools })),
    fromCache: false,
  }));

  // Operator A: a hostile prober, same scaffolding + toolset on two surfaces.
  const scA = scaff(); const tA = tools();
  await recordSighting({ workspaceId: "w1", sighting: { surface: "ogiam.com", at: "2026-09-18T10:00:00Z", journey: journey("vuln_scanner", "proven"), scaffolding: scA, tools: tA } });
  await recordSighting({ workspaceId: "w1", sighting: { surface: "client.com", at: "2026-09-18T11:00:00Z", journey: journey("vuln_scanner", "proven"), scaffolding: scA, tools: tA } });
  // Operator B: a benign crawler with a different scaffolding (link-following).
  await recordSighting({ workspaceId: "w1", sighting: { surface: "ogiam.com", at: "2026-09-18T12:00:00Z", journey: journey("benign_crawler", "proven"), scaffolding: scaff({ pathDiscovery: "link-following" }), tools: tools() } });
  // A different workspace must not bleed in.
  await recordSighting({ workspaceId: "w2", sighting: { surface: "other.com", at: "2026-09-18T13:00:00Z", journey: journey("vuln_scanner", "proven"), scaffolding: scA, tools: tA } });

  const operators = await getOperators("w1", 30);
  expect(operators).toHaveLength(2); // w2 excluded
  const a = operators.find((o) => o.threatLevel === "hostile")!;
  expect(a.sightingCount).toBe(2);
  expect(a.surfaces.slice().sort()).toEqual(["client.com", "ogiam.com"]); // one operator, two surfaces
  expect(a.confidence).toBe("proven");
  expect(operators.some((o) => o.threatLevel === "benign")).toBe(true); // operator B distinct
});
