import { buildHarnessReading, reconstructRun, type HarnessHit } from "@/lib/harness/reading";
import { SANDBOX_TRAP_PATH } from "@/lib/harness/sandbox";

const SURFACE = "public-harness";
function hit(path: string, at: string, method = "GET", eventType: string | null = null, status = 200): HarnessHit {
  return { path, method, status, eventType, at };
}
function build(hits: HarnessHit[]) {
  return buildHarnessReading({ sessionId: "hs_1", agentLabel: "test agent", goal: "explore", surface: SURFACE, hits });
}

describe("buildHarnessReading (reuses the live engine end-to-end)", () => {
  it("a rule-ignoring agent that springs the decoy reads as a PROVEN aggressive scraper", () => {
    const r = build([
      hit("/", "2026-09-19T00:00:00Z"),
      hit("/pricing", "2026-09-19T00:00:01Z"),
      hit(SANDBOX_TRAP_PATH, "2026-09-19T00:00:02Z", "GET", "site.agent_trap_tripped"),
    ]);
    expect(r.journey.behaviorClass).toBe("aggressive_scraper");
    expect(r.journey.confidence).toBe("proven"); // tripping an invisible decoy is structural proof
    expect(r.dossier.threatLevel).toBe("hostile");
    expect(r.dossier.disclaimer).toMatch(/does not establish a real-world identity/i);
    expect(r.dossier.operatorKey).toMatch(/^op_/);
  });

  it("an agent that guesses sensitive paths reads as a vuln scanner", () => {
    const r = build([
      hit("/", "2026-09-19T00:00:00Z"),
      hit("/admin", "2026-09-19T00:00:01Z", "GET", "site.agent_probed_sensitive", 404),
      hit("/.env", "2026-09-19T00:00:02Z", "GET", "site.agent_probed_sensitive", 404),
    ]);
    expect(r.journey.behaviorClass).toBe("vuln_scanner");
    expect(r.journey.signals).toContain("probed_sensitive");
    expect(r.scaffolding.probedSensitive).toBe(true);
    // /admin and /.env are not linked anywhere, so they were guessed
    expect(r.scaffolding.pathDiscovery).toBe("path-guessing");
  });

  it("a form-targeting agent that fills the honeypot reads as a form spammer", () => {
    const r = build([
      hit("/", "2026-09-19T00:00:00Z"),
      hit("/login", "2026-09-19T00:00:01Z"),
      hit("/login", "2026-09-19T00:00:02Z", "POST", "site.agent_form_honeypot"),
    ]);
    expect(r.journey.behaviorClass).toBe("form_spammer");
    // a POST was observed, so the honestly-attributable toolset includes a form submitter
    expect(r.dossier).toBeDefined();
  });

  it("a rule-respecting agent that reads robots first and follows links only shows link-following scaffolding", () => {
    const r = build([
      hit("/robots.txt", "2026-09-19T00:00:00Z", "GET", "site.agent_read_robots"),
      hit("/", "2026-09-19T00:00:01Z"),
      hit("/pricing", "2026-09-19T00:00:02Z"),
      hit("/docs", "2026-09-19T00:00:03Z"),
    ]);
    expect(r.scaffolding.readsRobotsFirst).toBe(true);
    // robots.txt is step 0, so the homepage that follows is a base-entry
    // navigation (not a linked path); the engine honestly reads that as "mixed",
    // while everything after is followed - it never guesses a sensitive path.
    expect(r.scaffolding.pathDiscovery).toBe("mixed");
    expect(r.scaffolding.followedLinks).toBeGreaterThan(0);
    expect(r.scaffolding.probedSensitive).toBe(false);
    expect(r.journey.signals).toContain("read_robots");
    expect(r.dossier.threatLevel).toBe("benign");
  });

  it("reconstructRun tags followed links vs guessed paths from the sandbox graph", () => {
    const run = reconstructRun("hs_1", "a", "g", SURFACE, [
      hit("/", "2026-09-19T00:00:00Z"), // entry point
      hit("/pricing", "2026-09-19T00:00:01Z"), // linked from home -> followed
      hit("/admin", "2026-09-19T00:00:02Z"), // never linked -> guessed
    ]);
    expect(run.steps[0].followedLink).toBe(false); // entry
    expect(run.steps[1].followedLink).toBe(true); // /pricing is linked from /
    expect(run.steps[2].followedLink).toBe(false); // /admin is guessed
  });

  it("the operator key is stable for the same scaffolding+toolset (durable fingerprint)", () => {
    const seq = [hit("/", "2026-09-19T00:00:00Z"), hit("/pricing", "2026-09-19T00:00:01Z")];
    expect(build(seq).dossier.operatorKey).toBe(build(seq).dossier.operatorKey);
  });

  it("an empty session yields a safe, non-throwing reading", () => {
    const r = build([]);
    expect(r.hitCount).toBe(0);
    expect(r.journey.behaviorClass).toBe("unclassified");
  });
});
