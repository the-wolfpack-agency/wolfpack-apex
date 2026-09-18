/**
 * Agent-vs-site probe harness: SSRF safety, scaffolding fingerprinting, and the
 * shared-classifier reuse. Deterministic - injected driver, fetch, and clock.
 */
import {
  isWithinBase, extractLinkPaths, signalEventForPath, isSensitiveProbe,
  runAgentProbe, deriveScaffoldingSignature, reportProbeRun, type ProbeDriverCtx,
} from "@/lib/agent-probe";

const clock = () => "2026-09-18T10:00:00Z";
const BASE = "https://ogiam.com";

/** A scripted agent: fetches a fixed list of paths in order, then stops. */
function scriptedDriver(paths: string[]) {
  let i = 0;
  return async (_ctx: ProbeDriverCtx) => (i < paths.length ? paths[i++] : null);
}
/** Fetch stub: returns a body whose links are configurable per path. */
function fetchStub(links: Record<string, string[]> = {}) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    const body = (links[path] ?? []).map((l) => `<a href="${l}">x</a>`).join("");
    const status = path.startsWith("/_ff") || isSensitiveProbe(path) ? 404 : 200;
    return { status, body };
  };
}

describe("SSRF guard", () => {
  it("allows same-origin, blocks everything else", () => {
    expect(isWithinBase("/pricing", BASE)).toBe(true);
    expect(isWithinBase("https://ogiam.com/x", BASE)).toBe(true);
    expect(isWithinBase("https://evil.com/x", BASE)).toBe(false);
    expect(isWithinBase("http://ogiam.com/x", BASE)).toBe(false); // protocol mismatch
    expect(isWithinBase("file:///etc/passwd", BASE)).toBe(false);
  });
});

describe("path -> signal + link extraction", () => {
  it("maps decoy / robots / probe paths to the shared vocabulary", () => {
    expect(signalEventForPath("/_ff/records")).toBe("site.agent_trap_tripped");
    expect(signalEventForPath("/robots.txt")).toBe("site.agent_read_robots");
    expect(signalEventForPath("/.env")).toBe("site.agent_probed_sensitive");
    expect(signalEventForPath("/pricing")).toBeNull();
  });
  it("extracts link paths from html", () => {
    expect(extractLinkPaths('<a href="/a">x</a><a href="/b?q=1">y</a>', BASE)).toEqual(["/a", "/b"]);
  });
});

describe("runAgentProbe captures the scaffolding trace", () => {
  it("stops at an out-of-base URL without fetching it (SSRF)", async () => {
    const run = await runAgentProbe({
      runId: "r1", agentLabel: "test", goal: "g", base: BASE,
      driver: scriptedDriver(["/pricing", "https://evil.com/steal"]),
      fetchImpl: fetchStub({ "/pricing": [] }), clock,
    });
    expect(run.steps.map((s) => s.path)).toEqual(["/pricing"]); // evil.com never fetched
  });

  it("tags a followed link vs a guessed path", async () => {
    const run = await runAgentProbe({
      runId: "r2", agentLabel: "test", goal: "g", base: BASE,
      // starts at / (given), follows /pricing (linked from /), then GUESSES /admin
      driver: scriptedDriver(["/", "/pricing", "/admin"]),
      fetchImpl: fetchStub({ "/": ["/pricing"], "/pricing": [] }), clock,
    });
    const byPath = Object.fromEntries(run.steps.map((s) => [s.path, s.followedLink]));
    expect(byPath["/pricing"]).toBe(true); // was linked from /
    expect(byPath["/admin"]).toBe(false); // never seen -> guessed
  });
});

describe("scaffolding signature = the framework fingerprint", () => {
  it("a link-following, robots-first scaffolding reads as polite", async () => {
    const run = await runAgentProbe({
      runId: "r3", agentLabel: "polite", goal: "g", base: BASE,
      driver: scriptedDriver(["/robots.txt", "/pricing"]),
      fetchImpl: fetchStub({ "/robots.txt": ["/pricing"], "/pricing": [] }), clock,
    });
    const sig = deriveScaffoldingSignature(run);
    expect(sig.readsRobotsFirst).toBe(true);
    expect(sig.pathDiscovery).toBe("link-following");
    expect(sig.probedSensitive).toBe(false);
  });

  it("a path-guessing scaffolding that probes reads as recon", async () => {
    const run = await runAgentProbe({
      runId: "r4", agentLabel: "aggressive", goal: "g", base: BASE,
      driver: scriptedDriver(["/", "/admin", "/.env", "/wp-login.php"]),
      fetchImpl: fetchStub({ "/": [] }), clock, // no links -> everything after / is guessed
    });
    const sig = deriveScaffoldingSignature(run);
    expect(sig.pathDiscovery).toBe("path-guessing");
    expect(sig.guessedPaths).toBe(3);
    expect(sig.probedSensitive).toBe(true);
  });
});

describe("reportProbeRun reuses the shared classifier", () => {
  it("classifies a probing agent as a vuln scanner, proven (harness knows it is one agent)", async () => {
    const run = await runAgentProbe({
      runId: "r5", agentLabel: "gpt+custom", goal: "find the admin panel", base: BASE,
      driver: scriptedDriver(["/", "/admin", "/.env"]),
      fetchImpl: fetchStub({ "/": [] }), clock,
    });
    const report = reportProbeRun(run);
    expect(report.journey.behaviorClass).toBe("vuln_scanner");
    expect(report.journey.confidence).toBe("proven");
    expect(report.scaffolding.pathDiscovery).toBe("path-guessing");
  });

  it("classifies a decoy-tripping agent as an aggressive scraper", async () => {
    const run = await runAgentProbe({
      runId: "r6", agentLabel: "greedy", goal: "grab everything", base: BASE,
      driver: scriptedDriver(["/", "/_ff/records"]),
      fetchImpl: fetchStub({ "/": ["/_ff/records"] }), clock,
    });
    expect(reportProbeRun(run).journey.behaviorClass).toBe("aggressive_scraper");
  });
});
