/** @jest-environment node */
import { proofOf, replayIntent, type ReplayEvent } from "@/lib/forcefield/intent-replay";
import { planCarryover } from "@/lib/forcefield/intent-carryover";

const T0 = 1_800_000_000_000;
let n = 0;
function ev(sig: string, type: string, path: string, extra: Partial<ReplayEvent> = {}): ReplayEvent {
  n++;
  return { ts: T0 + n * 1000, type, path, site: "site-a", sig, fp: `aa${sig}:unknown`, clientType: "unknown", ...extra };
}
const STACKS = { "site-a": ["nextjs"], "site-b": ["nextjs"] };

describe("intent replay over recorded events", () => {
  it("proofOf ignores the control-plane middleware artefact and synthetic probes", () => {
    expect(proofOf(ev("s", "site.agent_payload_attack", "/api/forcefield/ruleset", { attack: "nextjs_middleware_bypass" }))).toBeNull();
    expect(proofOf(ev("s", "site.agent_payload_attack", "/x", { attack: "sql_injection" }))).toBe("payload");
    expect(proofOf(ev("s", "site.agent_trap_tripped", "/_ff/records", { synthetic: true }))).toBeNull();
  });

  it("TRUE POSITIVE fixture: recon then payload is held back before the payload", () => {
    const events = [
      ev("h1", "site.agent_flagged", "/wp-content/plugins/a/readme.txt"),
      ev("h1", "site.agent_flagged", "/wp-content/plugins/b/readme.txt"),
      ev("h1", "site.agent_flagged", "/bitrix/admin/"),
      ev("h1", "site.agent_payload_attack", "/x", { attack: "sql_injection" }),
    ];
    const r = replayIntent(events, { stacks: STACKS });
    expect(r.hostile).toMatchObject({ sessions: 1, withPrecursors: 1, tarpittedBeforeProof: 1, medianRequestsEarlier: 2, medianSecondsEarlier: 2 });
  });

  it("TRUE NEGATIVE fixture: human page views and a welcomed crawler are never slowed", () => {
    const events = [
      ev("b1", "site.page_viewed", "/", { clientType: null }),
      ev("b1", "site.page_viewed", "/pricing", { clientType: null }),
      ev("b2", "site.agent_welcomed", "/old.php", { clientType: "known_crawler" }),
      ev("b2", "site.agent_welcomed", "/older.php", { clientType: "known_crawler" }),
    ];
    const r = replayIntent(events, { stacks: STACKS });
    expect(r.neverHostile).toMatchObject({ knownBenign: 2, knownBenignTarpitted: 0, knownBenignWatched: 0 });
  });

  it("counts follow-on requests a sticky block would have turned away", () => {
    const events = [ev("p1", "site.agent_trap_tripped", "/_ff/records"), ev("p1", "site.agent_flagged", "/"), ev("p1", "site.agent_flagged", "/contact")];
    expect(replayIntent(events, { stacks: STACKS }).hostile).toMatchObject({ followOnRequestsBlocked: 2, sessionsWithFollowOnBlocked: 1 });
  });

  it("carryover: a distinctive fingerprint proven on one site tarpits it on another; a generic one is withheld", () => {
    const events = [
      ev("c1", "site.agent_payload_attack", "/x", { fp: "beef:nuclei", clientType: "scanner", attack: "xss" }),
      ev("c2", "site.agent_flagged", "/", { fp: "beef:nuclei", clientType: "scanner", site: "site-b" }),
      ev("c3", "site.agent_payload_attack", "/x", { fp: "cafe:curl", clientType: "scripted_library", attack: "xss" }),
      ev("c4", "site.agent_flagged", "/", { fp: "cafe:curl", clientType: "scripted_library", site: "site-b" }),
    ];
    const r = replayIntent(events, { stacks: STACKS });
    expect(r.carryover).toMatchObject({ entries: 1, genericWithheld: 1, sessionsCarried: 1 });
  });
});

describe("planCarryover (the distributed list)", () => {
  const now = new Date(T0);
  it("keeps distinctive, fresh fingerprints with an expiry; withholds generic ones; drops stale ones", async () => {
    const r = await planCarryover(
      [
        { fp: "beef:nuclei", lastProof: new Date(T0 - 86_400_000).toISOString() },
        { fp: "cafe:curl", lastProof: new Date(T0 - 1000).toISOString() },
        { fp: "dead:sqlmap", lastProof: new Date(T0 - 30 * 86_400_000).toISOString() },
        { fp: "f00d:unknown", lastProof: new Date(T0 - 1000).toISOString() },
      ],
      { now, scope: { loadSpread: async () => ({ kinds: 1, countries: 1 }) } },
    );
    expect(r.entries.map((e) => e.fp).sort()).toEqual(["beef:nuclei", "f00d:unknown"]);
    expect(r.withheldGeneric).toBe(1);
    expect(r.entries.find((e) => e.fp === "beef:nuclei")?.expiresAt).toBe(new Date(T0 - 86_400_000 + 7 * 86_400_000).toISOString());
  });
  it("an unreadable spread withholds an unknown-kind fingerprint (fail toward not slowing)", async () => {
    const r = await planCarryover([{ fp: "f00d:unknown", lastProof: new Date(T0).toISOString() }], { now, scope: { loadSpread: async () => null } });
    expect(r.entries).toEqual([]);
  });
});
