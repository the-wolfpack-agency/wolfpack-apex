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

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every URL pattern Instinct really serves: app-router page/route files
 *  (route groups and parallel slots stripped) plus public/ files. */
function instinctRoutes(): string[][] {
  const root = join(__dirname, "../../../app");
  const out: string[][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "__tests__" || name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(page|route)\.(t|j)sx?$/.test(name)) {
        const segs = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
        out.push(segs);
      }
    }
  };
  walk(root);
  const pub = join(__dirname, "../../../../public");
  const walkPub = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkPub(p);
      else out.push(relative(pub, p).split(sep));
    }
  };
  try { walkPub(pub); } catch { /* no public dir */ }
  return out;
}

const isDynamic = (s: string) => s.startsWith("[");
const isCatchAll = (s: string) => s.startsWith("[...") || s.startsWith("[[...");

/** Could a request to `pattern` (or a path under it) be served by `route`? */
function collides(route: string[], pattern: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    const r = route[i];
    if (r === undefined) return false; // route is shallower and has no catch-all
    if (isCatchAll(r)) return true;
    if (r !== p[i] && !isDynamic(r)) return false;
  }
  return true; // route is the pattern itself or lives under it
}

describe("sensitivePaths never name a REAL Instinct route (route-collision guard)", () => {
  const routes = instinctRoutes();

  it("walks a real route tree", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("positive control: the guard DOES catch a real route (/api/version) and a dynamic one", () => {
    expect(routes.filter((r) => collides(r, "/api/version")).length).toBeGreaterThan(0);
    expect(collides(["sites", "[id]", "edit"], "/sites/abc")).toBe(true);
    expect(collides(["docs", "[...slug]"], "/docs/a/b")).toBe(true);
    expect(collides(["api"], "/api/tags")).toBe(false);
  });

  it.each(DEFAULT_RULESET.sensitivePaths)("%s is not served by any Instinct page/route/public file", (pattern) => {
    const hits = routes
      // A root-level dynamic segment would make every path "collide"; Instinct has
      // none today, and if one appears this guard should be re-thought, not skipped.
      .filter((r) => collides(r, pattern))
      .map((r) => "/" + r.join("/"));
    expect(hits).toEqual([]);
  });
});

describe("bundled ruleset shape", () => {
  it("declares WordPress-native platform paths and no bundled crawler ranges", () => {
    expect(DEFAULT_RULESET.platformPaths?.wordpress).toEqual(expect.arrayContaining(["/wp-login.php", "/wp-admin", "/xmlrpc.php", "/wp-json", "/wp-content", "/wp-includes", "/wp-cron.php", "/wp-signup.php"]));
    expect(DEFAULT_RULESET.verifiedAgentRanges).toEqual({});
  });
  it("every knownAgent id is unique and every uaMatch distinct", () => {
    const ids = DEFAULT_RULESET.knownAgents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const m = DEFAULT_RULESET.knownAgents.map((a) => a.uaMatch.toLowerCase());
    expect(new Set(m).size).toBe(m.length);
  });
  it("round-trips through coerceRuleset (what every site fetches)", () => {
    const c = coerceRuleset(JSON.parse(JSON.stringify({ ...DEFAULT_RULESET, verifiedAgentRanges: { GPTBot: ["1/32"], Bad: [1] } })))!;
    expect(c.platformPaths).toEqual(DEFAULT_RULESET.platformPaths);
    expect(c.verifiedAgentRanges).toEqual({ GPTBot: ["1/32"] }); // malformed entry dropped
    expect(c.sensitivePaths).toEqual(DEFAULT_RULESET.sensitivePaths);
  });
});
