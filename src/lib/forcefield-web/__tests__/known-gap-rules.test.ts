/**
 * The three engine rules that closed the long-standing coverage gaps
 * (SECRET-FILES, WP-PLUGIN-ABUSE, CRAWLER-IMPERSONATION). Each rule has true
 * positives AND lookalike true negatives: a false positive on a real route or a
 * real crawler is worse than the gap, so the negatives are the point.
 * Semantics kept: probes are report-only, impersonation is flagged, not blocked.
 */
import { observeRequest, type ObserveInput } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { DEFAULT_RULESET, type ForcefieldRuleset } from "@/lib/forcefield-web/ruleset";
import { parseCidr, verifyAgentByRanges } from "@/lib/forcefield-web/hosting";
import { THREAT_COVERAGE, THREAT_SPECS, runThreatCheck } from "@/lib/forcefield/threat-coverage";

const R = DEFAULT_RULESET;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BROWSER_HEADERS = ["host", "accept", "accept-language", "accept-encoding", "user-agent"];

function req(rawUrl: string, over: Partial<ObserveInput> = {}): ObserveInput {
  const q = rawUrl.indexOf("?");
  return {
    site: "test", path: q === -1 ? rawUrl : rawUrl.slice(0, q), rawUrl, method: "GET",
    userAgent: BROWSER_UA, country: "US", headerNames: BROWSER_HEADERS, nowMs: 1_758_000_000_000, ...over,
  };
}
const obs = (rawUrl: string, over: Partial<ObserveInput> = {}, ruleset: ForcefieldRuleset = R) => observeRequest(req(rawUrl, over), ruleset);
const blocked = (rawUrl: string, over: Partial<ObserveInput> = {}, ruleset: ForcefieldRuleset = R) => {
  const r = req(rawUrl, over);
  return decideEnforcement({ path: r.path, rawUrl: r.rawUrl, method: r.method, userAgent: r.userAgent, headerNames: r.headerNames, ip: r.ip, authenticated: r.authenticated }, ruleset).block;
};

describe("SECRET-FILES: a .env file below the root", () => {
  it.each(["/api/.env", "/app/.env", "/backend/.env.production", "/laravel/core/.env", "/api/.env.local", "/api/.env.bak", "/src/.env~", "/x/.env/config", "/API/.ENV"])(
    "%s is reported as a probe from a browser-shaped client",
    (p) => {
      const o = obs(p)!;
      expect(o.type).toBe("site.agent_probed_sensitive");
      expect(o.props.probe).toBe("nested_dotenv");
    },
  );

  it("the root variants keep their existing pattern label", () => {
    for (const p of ["/.env", "/.env.local", "/.env.production", "/.env.bak"]) expect(obs(p)!.props.probe).toMatch(/^\/\.env/);
  });

  it.each([
    "/environment", "/api/environment", "/api/.environment", "/api/.envoy", "/api/.envelope/x", "/assets/env.js",
    "/static/js/env.config.js", "/docs/dotenv", "/blog/what-is-a-.env-file", "/api/env", "/config/.envrc-guide",
    // Committed templates hold no secrets; a docs or code-browsing route may show one.
    "/app/.env.example", "/repo/.env.sample", "/repo/.env.template", "/repo/.env.dist",
  ])("%s (lookalike) is NOT a probe", (p) => {
    expect(obs(p)?.props.probe).toBeUndefined();
  });

  it("is report-only: never blocked on its own", () => {
    expect(blocked("/api/.env")).toBe(false);
  });

  it("still fires on a WordPress site (no platform owns a .env)", () => {
    expect(obs("/blog/.env", { platform: "wordpress" })!.props.probe).toBe("nested_dotenv");
  });
});

describe("WP-PLUGIN-ABUSE: anonymous calls to plugin endpoints with a missing-auth flaw", () => {
  const wp = { platform: "wordpress", authenticated: false } as const;

  it.each([
    ["/wp-admin/admin-ajax.php?action=updraft_central", "wp_plugin_updraftcentral_ajax"],
    ["/wp-admin/admin-ajax.php?action=updraft_central_ajax&x=1", "wp_plugin_updraftcentral_ajax"],
    ["/blog/wp-admin/admin-ajax.php?foo=1&action=UPDRAFT_CENTRAL", "wp_plugin_updraftcentral_ajax"],
    ["/wp-json/rankmath/v1/updateMeta", "wp_plugin_rankmath_updatemeta"],
    ["/wp-json/rankmath/v1/updatemeta/", "wp_plugin_rankmath_updatemeta"],
    ["/wp-json/rankmath/v1/updatemeta///", "wp_plugin_rankmath_updatemeta"],
    ["/blog/wp-json/rankmath/v1/updateMeta", "wp_plugin_rankmath_updatemeta"],
    ["/?rest_route=/rankmath/v1/updateMeta", "wp_plugin_rankmath_updatemeta"],
    ["/index.php?rest_route=%2Frankmath%2Fv1%2FupdateMeta", "wp_plugin_rankmath_updatemeta"],
  ])("%s on a WordPress site is reported as %s", (p, label) => {
    const o = obs(p, wp)!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    // The plugin rule is the reason, not the core path.
    expect(o.props.probe).toBe(label);
  });

  it("a long run of slashes in the route is classified in linear time (no regex backtracking)", () => {
    const t = Date.now();
    expect(obs("/wp-json/" + "/".repeat(200_000) + "x", wp)?.props?.probe ?? null).not.toBe("wp_plugin_rankmath_updatemeta");
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it.each([
    "/wp-admin/admin-ajax.php?action=heartbeat",
    "/wp-admin/admin-ajax.php?action=wp-compression-test",
    "/wp-admin/admin-ajax.php?action=updraftplus_ajax",
    "/wp-admin/admin-ajax.php?action=rank_math_ajax",
    "/wp-admin/admin-ajax.php",
    "/wp-admin/admin-ajax.php?updraft_central=1",
    "/wp-json/rankmath/v1/getHead",
    "/wp-json/rankmath/v1/updateMetaBulk",
    "/wp-json/wp/v2/posts",
    "/?rest_route=/wp/v2/posts",
    "/rankmath/v1/updateMeta",
  ])("%s (core WP or other plugin route) is NOT a probe on a WordPress site", (p) => {
    expect(obs(p, wp)?.type ?? "none").not.toBe("site.agent_probed_sensitive");
  });

  it("a WordPress-attested signed-in user calling the same endpoints is not a probe", () => {
    for (const p of ["/wp-admin/admin-ajax.php?action=updraft_central", "/wp-json/rankmath/v1/updateMeta"]) {
      expect(obs(p, { platform: "wordpress", authenticated: true })?.type ?? "none").not.toBe("site.agent_probed_sensitive");
    }
  });

  it("is report-only: never blocked on its own", () => {
    expect(blocked("/wp-json/rankmath/v1/updateMeta", wp)).toBe(false);
    expect(blocked("/wp-admin/admin-ajax.php?action=updraft_central", wp)).toBe(false);
  });

  it("on a non-WP site the core path already reports it (unchanged)", () => {
    expect(obs("/wp-json/rankmath/v1/updateMeta")!.type).toBe("site.agent_probed_sensitive");
  });

  it("a malformed query never throws", () => {
    expect(() => obs("/wp-admin/admin-ajax.php?action=%E0%A4%A", wp)).not.toThrow();
  });
});

describe("CRAWLER-IMPERSONATION: claimed crawler from outside its published ranges", () => {
  const GPT_UA = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
  const compact = (cidr: string) => { const p = parseCidr(cidr)!; return `${p.base >>> 0}/${p.bits}`; };
  const shapes: Array<[string, string[]]> = [["dotted CIDR", ["20.15.240.64/28"]], ["compact base/bits", [compact("20.15.240.64/28")]]];

  it.each(shapes)("%s: an impersonator is flagged with impersonating, a real GPTBot is welcomed as verified", (_n, list) => {
    const ruleset: ForcefieldRuleset = { ...R, verifiedAgentRanges: { GPTBot: list } };
    const fake = obs("/", { userAgent: GPT_UA, ip: "203.0.113.9", headerNames: [] }, ruleset)!;
    expect(fake.type).toBe("site.agent_flagged");
    expect(fake.props).toMatchObject({ impersonating: "GPTBot", agent_verification: "impersonation" });
    const real = obs("/", { userAgent: GPT_UA, ip: "20.15.240.70", headerNames: [] }, ruleset)!;
    expect(real.type).toBe("site.agent_welcomed");
    expect(real.props.agent_verification).toBe("verified");
    expect(real.props.impersonating).toBeUndefined();
  });

  it("is flagged, not blocked, on impersonation alone", () => {
    const ruleset: ForcefieldRuleset = { ...R, verifiedAgentRanges: { GPTBot: ["20.15.240.64/28"] } };
    expect(blocked("/", { userAgent: GPT_UA, ip: "203.0.113.9", headerNames: [] }, ruleset)).toBe(false);
  });

  it("dotted CIDR: boundaries are exact, malformed and IPv6 stay unverifiable", () => {
    const ranges = { GPTBot: ["20.15.240.64/28"] };
    expect(verifyAgentByRanges("GPTBot", "20.15.240.64", ranges)).toBe("verified");
    expect(verifyAgentByRanges("GPTBot", "20.15.240.79", ranges)).toBe("verified");
    expect(verifyAgentByRanges("GPTBot", "20.15.240.80", ranges)).toBe("impersonation");
    expect(verifyAgentByRanges("GPTBot", "20.15.240.63", ranges)).toBe("impersonation");
    expect(verifyAgentByRanges("GPTBot", "203.0.113.9", { GPTBot: ["999.1.1.1/8", "1.2.3.4/33"] })).toBe("unverifiable");
    expect(verifyAgentByRanges("GPTBot", "2001:db8::1", ranges)).toBe("unverifiable");
  });

  it("no ranges (the bundled default) never convicts a claimed crawler", () => {
    expect(obs("/", { userAgent: GPT_UA, ip: "203.0.113.9", headerNames: [] })!.props.agent_verification).toBe("unverifiable");
  });
});

describe("the three coverage rows are earned by their computed checks", () => {
  it.each(["SECRET-FILES", "WP-PLUGIN-ABUSE", "CRAWLER-IMPERSONATION"])("%s runs its samples and earns covered", (id) => {
    const spec = THREAT_SPECS.find((s) => s.id === id)!;
    expect(runThreatCheck(spec.check)).toBe("covered");
    expect(THREAT_COVERAGE.find((e) => e.id === id)!.status).toBe("covered");
  });
});
