import { coerceRuleset, fetchRuleset, _resetRulesetCache, DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const valid = {
  version: "test-1",
  knownAgents: [{ id: "X", uaMatch: "x" }],
  trapPaths: ["/_ff/records"],
  sensitivePaths: ["/.env"],
  toolSignatures: [["curl", "curl/", "scripted_library"]],
};
const ok = (r: Response | { ok: boolean; json: () => Promise<unknown> }) => r as unknown as Response;

beforeEach(() => _resetRulesetCache());

describe("coerceRuleset - malformed remote payloads fail closed to null (-> default)", () => {
  it("accepts a well-formed payload", () => {
    expect(coerceRuleset(valid)?.version).toBe("test-1");
  });
  it("rejects garbage / missing arrays", () => {
    expect(coerceRuleset(null)).toBeNull();
    expect(coerceRuleset({ trapPaths: ["/x"] })).toBeNull(); // missing others
    expect(coerceRuleset({ ...valid, toolSignatures: [["bad", "shape"]] })).toBeNull(); // wrong tuple len
  });
});

describe("fetchRuleset - update-once seam, FAIL-OPEN", () => {
  it("returns and caches a valid remote ruleset", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ ok: true, json: async () => ({ ruleset: valid }) }));
    const r = await fetchRuleset("https://x/api/forcefield/ruleset", { nowMs: 1000, fetchImpl });
    expect(r.version).toBe("test-1");
    // within TTL, the second call is served from cache (no second fetch)
    await fetchRuleset("https://x/api/forcefield/ruleset", { nowMs: 2000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls open to the bundled default when the fetch throws", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
    const r = await fetchRuleset("https://x", { nowMs: 1000, fetchImpl });
    expect(r).toBe(DEFAULT_RULESET);
  });

  it("falls open when the endpoint returns malformed JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ ok: true, json: async () => ({ nope: 1 }) }));
    const r = await fetchRuleset("https://x", { nowMs: 1000, fetchImpl });
    expect(r).toBe(DEFAULT_RULESET);
  });

  it("serves the last-good cache when a later fetch fails (never regresses to default mid-flight)", async () => {
    const good = jest.fn().mockResolvedValue(ok({ ok: true, json: async () => ({ ruleset: valid }) }));
    await fetchRuleset("https://x", { nowMs: 1000, fetchImpl: good });
    const bad = jest.fn().mockRejectedValue(new Error("blip"));
    const r = await fetchRuleset("https://x", { nowMs: 10_000_000, ttlMs: 1, fetchImpl: bad }); // TTL expired -> refetch -> fails
    expect(r.version).toBe("test-1"); // still the last good ruleset, not the bundled default
  });

  it("runs purely on bundled defaults when given an empty URL", async () => {
    const r = await fetchRuleset("", { nowMs: 1000 });
    expect(r).toBe(DEFAULT_RULESET);
  });
});
