/**
 * Agent behavior classifier - the fused-signal verdict + the proven/inferred
 * honesty rail. Pure, no I/O.
 */
import { classifySession, buildJourneys, type SessionEvent } from "@/lib/agent-behavior";

const ev = (type: string, path: string, at: string, extra: Partial<SessionEvent> = {}): SessionEvent => ({ type, path, at, ...extra });

describe("classifySession", () => {
  it("a decoy trip is a PROVEN aggressive scraper (structurally a bot, ignored the rules)", () => {
    const j = classifySession({
      key: "sig-1",
      keyKind: "fingerprint", // even grouped by fingerprint...
      events: [ev("site.agent_trap_tripped", "/_ff/records", "2026-09-18T10:00:00Z")],
    });
    expect(j.behaviorClass).toBe("aggressive_scraper");
    // ...tripping the invisible decoy is something a human structurally cannot do,
    // so the verdict is PROVEN, not inferred.
    expect(j.confidence).toBe("proven");
    expect(j.signals).toContain("tripped_decoy");
  });

  it("a hidden-field form fill is a PROVEN form spammer", () => {
    const j = classifySession({ key: "n1", keyKind: "nonce", events: [ev("site.agent_form_honeypot", "/contact", "2026-09-18T10:00:00Z")] });
    expect(j.behaviorClass).toBe("form_spammer");
    expect(j.confidence).toBe("proven");
  });

  it("sensitive-path probing is a vuln scanner", () => {
    const j = classifySession({
      key: "sig-2",
      keyKind: "fingerprint",
      events: [ev("site.agent_probed_sensitive", "/.env", "2026-09-18T10:00:01Z"), ev("site.agent_probed_sensitive", "/wp-login", "2026-09-18T10:00:00Z")],
    });
    expect(j.behaviorClass).toBe("vuln_scanner");
    // A human CAN type /.env, so probing alone (grouped by fingerprint) is a
    // hypothesis, labeled inferred - not proven. The honesty rail in action.
    expect(j.confidence).toBe("inferred");
  });

  it("an identified, rule-respecting crawler is a benign crawler and only INFERRED unless nonce-tied", () => {
    const j = classifySession({
      key: "sig-3",
      keyKind: "fingerprint",
      events: [ev("site.agent_welcomed", "/pricing", "2026-09-18T10:00:00Z", { agent: "GPTBot" }), ev("site.agent_read_robots", "/robots.txt", "2026-09-18T09:59:00Z")],
    });
    expect(j.behaviorClass).toBe("benign_crawler");
    expect(j.confidence).toBe("inferred"); // fingerprint-grouped, no structural-bot signal
  });

  it("weak automation signal alone is 'suspicious', not a hard class", () => {
    const j = classifySession({ key: "s", keyKind: "fingerprint", events: [ev("site.agent_high_rate", "/", "2026-09-18T10:00:00Z")] });
    expect(j.behaviorClass).toBe("suspicious");
    expect(j.confidence).toBe("inferred");
  });

  it("orders the path by time and collapses consecutive duplicates", () => {
    const j = classifySession({
      key: "p",
      keyKind: "nonce",
      events: [
        ev("site.agent_welcomed", "/b", "2026-09-18T10:00:02Z"),
        ev("site.agent_welcomed", "/a", "2026-09-18T10:00:00Z"),
        ev("site.agent_welcomed", "/a", "2026-09-18T10:00:01Z"),
      ],
    });
    expect(j.path).toEqual(["/a", "/b"]);
    expect(j.firstAt).toBe("2026-09-18T10:00:00Z");
    expect(j.lastAt).toBe("2026-09-18T10:00:02Z");
  });
});

describe("buildJourneys", () => {
  it("groups events by correlation key and classifies each session, newest first", () => {
    const journeys = buildJourneys([
      { key: "A", keyKind: "fingerprint", type: "site.agent_trap_tripped", path: "/_ff/x", at: "2026-09-18T09:00:00Z" },
      { key: "B", keyKind: "nonce", type: "site.agent_form_honeypot", path: "/contact", at: "2026-09-18T11:00:00Z" },
      { key: "A", keyKind: "fingerprint", type: "site.agent_probed_sensitive", path: "/admin", at: "2026-09-18T09:00:05Z" },
    ]);
    expect(journeys).toHaveLength(2);
    expect(journeys[0].key).toBe("B"); // newest lastAt first
    expect(journeys[0].behaviorClass).toBe("form_spammer");
    // Session A fused two signals (decoy + probe) into one path.
    const a = journeys.find((j) => j.key === "A")!;
    expect(a.signals).toEqual(expect.arrayContaining(["tripped_decoy", "probed_sensitive"]));
    expect(a.path).toEqual(["/_ff/x", "/admin"]);
    expect(a.confidence).toBe("proven"); // tripped_decoy is structurally a bot
  });

  it("a nonce grouping upgrades a key's confidence over a fingerprint grouping", () => {
    const journeys = buildJourneys([
      { key: "K", keyKind: "fingerprint", type: "site.agent_read_robots", path: "/robots.txt", at: "2026-09-18T10:00:00Z" },
      { key: "K", keyKind: "nonce", type: "site.agent_form_honeypot", path: "/contact", at: "2026-09-18T10:00:05Z", nonceLinked: true },
    ]);
    expect(journeys[0].confidence).toBe("proven");
  });
});

describe("novel insights (classifySession)", () => {
  function ev(type: string, at: string, agent?: string) {
    return { type, path: "/x", at, agent };
  }

  it("flags impersonation: a welcomed known agent that then behaves hostilely", () => {
    const j = classifySession({
      key: "fp1",
      keyKind: "fingerprint",
      events: [
        ev("site.agent_welcomed", "2026-09-19T00:00:00Z", "GPTBot"),
        ev("site.agent_probed_sensitive", "2026-09-19T00:00:05Z"),
      ],
    });
    const imp = j.insights.find((i) => i.kind === "impersonation");
    expect(imp).toBeTruthy();
    expect(imp && "claimedAgent" in imp && imp.claimedAgent).toBe("GPTBot");
  });

  it("does NOT flag impersonation for a welcomed agent that stays benign", () => {
    const j = classifySession({
      key: "fp2",
      keyKind: "fingerprint",
      events: [ev("site.agent_welcomed", "2026-09-19T00:00:00Z", "Googlebot"), ev("site.agent_read_robots", "2026-09-19T00:00:01Z")],
    });
    expect(j.insights.some((i) => i.kind === "impersonation")).toBe(false);
  });

  it("flags deliberate_violation: read robots FIRST, then tripped the decoy", () => {
    const j = classifySession({
      key: "fp3",
      keyKind: "fingerprint",
      events: [ev("site.agent_read_robots", "2026-09-19T00:00:00Z"), ev("site.agent_trap_tripped", "2026-09-19T00:00:05Z")],
    });
    expect(j.insights.some((i) => i.kind === "deliberate_violation")).toBe(true);
  });

  it("does NOT flag deliberate_violation when the decoy trip came before reading robots", () => {
    const j = classifySession({
      key: "fp4",
      keyKind: "fingerprint",
      events: [ev("site.agent_trap_tripped", "2026-09-19T00:00:00Z"), ev("site.agent_read_robots", "2026-09-19T00:00:05Z")],
    });
    expect(j.insights.some((i) => i.kind === "deliberate_violation")).toBe(false);
  });
});

describe("payload-attack classification", () => {
  it("classifies a live injection payload as exploit_attempt (the most severe class) with a named insight", () => {
    const j = classifySession({
      key: "fp5",
      keyKind: "fingerprint",
      events: [{ type: "site.agent_payload_attack", path: "/search", at: "2026-09-19T00:00:00Z", attack: "sql_injection" }],
    });
    expect(j.behaviorClass).toBe("exploit_attempt");
    expect(j.signals).toContain("payload_attack");
    const ins = j.insights.find((i) => i.kind === "payload_attack");
    expect(ins).toBeTruthy();
    expect(ins && "attack" in ins && ins.attack).toBe("sql_injection");
    expect(j.summary).toMatch(/active exploitation/i);
  });
});
