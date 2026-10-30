/** @jest-environment node */
import { forcefieldGuard, forcefieldMonitor, _resetIntentLedger, evaluateRequestIntent } from "@/lib/forcefield-web/monitor";
import { _resetRulesetCache, DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { IntentLedger } from "@/lib/forcefield-web/intent";
import type { ObserveInput } from "@/lib/forcefield-web/observe";

const req = (path: string, ua = "python-requests/2.31", ip = "198.51.100.7") => ({
  method: "GET",
  nextUrl: { pathname: path },
  headers: new Headers({ "user-agent": ua, "x-vercel-ip-country": "US", "x-forwarded-for": ip }),
});

const KEYS = ["FORCEFIELD_WEB", "FORCEFIELD_ENFORCE", "FORCEFIELD_INTENT_ENFORCE", "SITE_ANALYTICS_INGEST_TOKEN", "FORCEFIELD_INGEST_URL", "FORCEFIELD_RULESET_URL"];
const ORIG = { ...process.env };
beforeEach(() => {
  _resetRulesetCache();
  _resetIntentLedger();
  process.env.FORCEFIELD_WEB = "on";
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret";
  process.env.FORCEFIELD_INGEST_URL = "https://hub.example/api/site-analytics/ingest";
  delete process.env.FORCEFIELD_RULESET_URL;
  delete process.env.FORCEFIELD_ENFORCE;
  delete process.env.FORCEFIELD_INTENT_ENFORCE;
});
afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function bodies(f: jest.SpyInstance): Array<{ type: string; props: Record<string, unknown> }> {
  // ingest sends only (the site-policy fetch is a GET without a body)
  return f.mock.calls.filter((c) => !String(c[0]).includes("/site-policy")).map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

describe("intent in the vendored monitor/guard", () => {
  it("RECORD-ONLY by default: records the step-up with applied:false and never slows or blocks", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    process.env.FORCEFIELD_ENFORCE = "on"; // enforcement on, intent enforcement NOT on
    for (const p of ["/bitrix/admin/", "/bitrix/tools/x"]) {
      const args = { site: "instinct", req: req(p), stack: ["nextjs"] };
      const t = Date.now();
      expect(await forcefieldGuard(args)).toBeNull();
      expect(Date.now() - t).toBeLessThan(1000);
      await forcefieldMonitor(args);
    }
    const intents = bodies(f).filter((b) => b.type === "site.intent_scored");
    expect(intents.map((b) => b.props.intent_action)).toEqual(["watch", "tarpit"]);
    expect(intents.every((b) => b.props.intent_applied === false)).toBe(true);
    expect(intents[1].props).toMatchObject({ site: "instinct", intent_details: "bitrix", intent_scope: "client" });
    expect(JSON.stringify(intents)).not.toContain("198.51.100.7");
  });

  it("with FORCEFIELD_INTENT_ENFORCE=on a tarpitted session is slowed, not blocked", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    process.env.FORCEFIELD_ENFORCE = "on";
    process.env.FORCEFIELD_INTENT_ENFORCE = "on";
    jest.useFakeTimers();
    expect(await forcefieldGuard({ site: "instinct", req: req("/bitrix/a"), stack: ["nextjs"] })).toBeNull();
    let settled = false;
    const p = forcefieldGuard({ site: "instinct", req: req("/bitrix/b"), stack: ["nextjs"] }).then((r) => {
      settled = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await p).toBeNull();
  });

  it("after a decoy is taken, the same client's follow-on requests are blocked (reason intent)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    process.env.FORCEFIELD_ENFORCE = "on";
    process.env.FORCEFIELD_INTENT_ENFORCE = "on";
    const trap = await forcefieldGuard({ site: "instinct", req: req("/_ff/records"), stack: ["nextjs"] });
    expect(trap?.reasonKind).toBe("decoy");
    const follow = await forcefieldGuard({ site: "instinct", req: req("/pricing"), stack: ["nextjs"] });
    expect(follow).toMatchObject({ block: true, reasonKind: "intent" });
    // A different client is untouched.
    expect(await forcefieldGuard({ site: "instinct", req: req("/pricing", "python-requests/2.31", "198.51.100.99"), stack: ["nextjs"] })).toBeNull();
  });

  it("a lone attack-tool request yields its own event only (no duplicate intent event)", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ site: "aidanmulready", req: req("/api/x", "sqlmap/1.7") });
    expect(bodies(f).map((b) => b.type)).toEqual(["site.agent_flagged"]);
  });

  it("control-plane requests are never scored", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    for (const p of ["/bitrix/a", "/bitrix/b"]) await forcefieldMonitor({ site: "instinct", req: req(p), stack: ["nextjs"], skipEnforcement: true });
    expect(bodies(f).some((b) => b.type === "site.intent_scored")).toBe(false);
  });

  it("a site with no declared stack gets no recon scoring", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    for (const p of ["/bitrix/a", "/bitrix/b", "/bitrix/c"]) await forcefieldMonitor({ site: "instinct", req: req(p) });
    expect(bodies(f).some((b) => b.type === "site.intent_scored")).toBe(false);
  });
});

describe("evaluateRequestIntent (shared with the central engine)", () => {
  const base: ObserveInput = { site: "s", path: "/", method: "GET", userAgent: "curl/8", country: "US", headerNames: ["user-agent", "accept"], nowMs: 1_800_000_000_000 };
  const allow = { block: false, reason: "" };
  it("carryover from the distributed ruleset tarpits a fresh session", () => {
    const ledger = new IntentLedger();
    const probe = evaluateRequestIntent(base, DEFAULT_RULESET, { ledger, obs: null, enforcement: allow, posture: "enforce" });
    const fp = String(probe?.props.fp);
    const ruleset = { ...DEFAULT_RULESET, intentCarryover: [{ fp, expiresAt: new Date(base.nowMs + 60_000).toISOString() }] };
    const r = evaluateRequestIntent({ ...base, ip: "192.0.2.1" }, ruleset, { ledger: new IntentLedger(), obs: null, enforcement: allow, posture: "enforce" });
    expect(r?.decision).toMatchObject({ action: "tarpit", applied: true });
    expect(r?.decision.reasons).toContain("carryover_hostile");
    const expired = evaluateRequestIntent({ ...base, ip: "192.0.2.1", nowMs: base.nowMs + 120_000 }, ruleset, { ledger: new IntentLedger(), obs: null, enforcement: allow, posture: "enforce" });
    expect(expired?.decision.action).toBe("none");
  });
  it("an authenticated request is never scored or carried over", () => {
    const ruleset = { ...DEFAULT_RULESET, intentCarryover: [] };
    const r = evaluateRequestIntent({ ...base, path: "/bitrix/a", authenticated: true, ip: "192.0.2.1" }, ruleset, { ledger: new IntentLedger(), obs: null, enforcement: allow, posture: "enforce", stack: ["nextjs"] });
    expect(r?.decision.action).toBe("none");
  });
});
