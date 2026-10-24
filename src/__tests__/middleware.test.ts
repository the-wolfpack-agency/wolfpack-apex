/** @jest-environment node */
/**
 * Middleware safety proof. The Forcefield self-defense is now the shared shim,
 * invoked only via waitUntil and only when enabled. The middleware must still set
 * every security header, and must register the shim ONLY when FORCEFIELD_WEB is on
 * - dark by default, never touching the response.
 */
const startSpan = jest.fn(() => ({ end: jest.fn() }));
jest.mock("@/lib/obs", () => ({ getObsClient: () => ({ startSpan }) }));
// signToken (the REAL producer of Instinct access JWTs) emits analytics; silence it.
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { middleware, forcefieldAuthenticated } from "@/middleware";
import { signToken } from "@/lib/crypto/sign";
import { _resetRulesetCache, DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { operatorFingerprint } from "@/lib/forcefield-web/fingerprint";

function req(path: string, ua = "Mozilla/5.0") {
  return new NextRequest(`https://wolfpack-instinct.vercel.app${path}`, { headers: { "user-agent": ua } });
}
const ev = () => {
  const waited: Promise<unknown>[] = [];
  return { event: { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never, waited };
};

const ORIG = { web: process.env.FORCEFIELD_WEB, enf: process.env.FORCEFIELD_ENFORCE };
afterEach(() => {
  if (ORIG.web === undefined) delete process.env.FORCEFIELD_WEB; else process.env.FORCEFIELD_WEB = ORIG.web;
  if (ORIG.enf === undefined) delete process.env.FORCEFIELD_ENFORCE; else process.env.FORCEFIELD_ENFORCE = ORIG.enf;
});

describe("middleware - security headers always applied", () => {
  it("sets CSP and hardening headers on every response", async () => {
    const { event } = ev();
    const res = await middleware(req("/dashboard"), event);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("Forcefield self-defense (shim invocation)", () => {
  it("is DARK by default: FORCEFIELD_WEB unset -> no shim registered, response intact", async () => {
    delete process.env.FORCEFIELD_WEB;
    const { event, waited } = ev();
    const res = await middleware(req("/", "sqlmap/1"), event);
    expect(waited).toHaveLength(0);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("when ON (monitor only): registers the shim via waitUntil and still returns the response (never blocks)", async () => {
    process.env.FORCEFIELD_WEB = "on";
    const { event, waited } = ev();
    const res = await middleware(req("/", "sqlmap/1"), event);
    expect(waited).toHaveLength(1); // the monitor promise, handed to waitUntil
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});


describe("Forcefield ENFORCEMENT (opt-in edge blocking)", () => {
  it("blocks a proven-hostile request with 403 when FORCEFIELD_ENFORCE=on", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    const { event } = ev();
    const res = await middleware(req("/", "sqlmap/1.7"), event); // named attack tool
    expect(res.status).toBe(403);
    expect(res.headers.get("x-forcefield")).toContain("blocked:");
  });

  it("NEVER blocks the Forcefield control-plane endpoints (ruleset/ingest), even for a hostile UA", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    const { event } = ev();
    const ruleset = await middleware(req("/api/forcefield/ruleset", "sqlmap/1.7"), event);
    expect(ruleset.status).not.toBe(403); // the channel that distributes blocks can't block itself
    const ingest = await middleware(req("/api/site-analytics/ingest", "sqlmap/1.7"), event);
    expect(ingest.status).not.toBe(403);
  });

  it("lets a normal human request through (200/next) even with enforcement on", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    const { event } = ev();
    const res = await middleware(req("/pricing", "Mozilla/5.0"), event);
    expect(res.status).not.toBe(403);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("does NOT block when enforcement is off (monitor only), even for sqlmap", async () => {
    process.env.FORCEFIELD_WEB = "on";
    delete process.env.FORCEFIELD_ENFORCE;
    delete process.env.FORCEFIELD_RULESET_URL;
    const { event } = ev();
    const res = await middleware(req("/", "sqlmap/1.7"), event);
    expect(res.status).not.toBe(403);
  });
});


describe("forcefieldAuthenticated - VERIFIES the credential, never trusts its presence", () => {
  const SECRET = "j".repeat(48);
  const ENV_KEYS = ["INSTINCT_JWT_SECRET", "APEX_JWT_SECRET", "CRON_SECRET", "INSTINCT_CRON_SECRET", "FACTORY_SERVICE_TOKEN", "FORCEFIELD_SYNTHETIC_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.INSTINCT_JWT_SECRET = SECRET;
  });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const withHeaders = (h: Record<string, string>) => new NextRequest("https://wolfpack-instinct.vercel.app/api/ms/chats/unread-count", { headers: h });
  const jwt = () => signToken({ userId: "u1", email: "a@example.org", name: "A", role: "admin" });

  it("a real Instinct access JWT (Bearer) verifies", async () => {
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${jwt()}` }))).toBe(true);
  });
  it("the access-token COOKIE verifies (browser navigations)", async () => {
    expect(await forcefieldAuthenticated(withHeaders({ cookie: `instinct_access_token=${jwt()}` }))).toBe(true);
  });
  it("a tampered, foreign-key, expired, alg:none or garbage token does NOT", async () => {
    const t = jwt();
    const [h, p, sig] = t.split(".");
    const tampered = `${h}.${p.slice(0, -2)}xx.${sig}`;
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${tampered}` }))).toBe(false);
    process.env.INSTINCT_JWT_SECRET = "k".repeat(48);
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${t}` }))).toBe(false); // signed with a different key
    process.env.INSTINCT_JWT_SECRET = SECRET;
    const expired = signToken({ userId: "u1" }, { ttlSeconds: 60 });
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${expired}` }), Date.now() + 120_000)).toBe(false);
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${none}` }))).toBe(false);
    expect(await forcefieldAuthenticated(withHeaders({ authorization: "Bearer not.a.jwt" }))).toBe(false);
    expect(await forcefieldAuthenticated(withHeaders({ authorization: "Bearer x" }))).toBe(false);
    expect(await forcefieldAuthenticated(withHeaders({}))).toBe(false);
  });
  it("no JWT secret configured -> fail closed", async () => {
    const t = jwt();
    delete process.env.INSTINCT_JWT_SECRET;
    expect(await forcefieldAuthenticated(withHeaders({ authorization: `Bearer ${t}` }))).toBe(false);
  });
  it("CRON_SECRET / INSTINCT_CRON_SECRET bearer (the GitHub-Actions crons) verify; a wrong one does not", async () => {
    process.env.CRON_SECRET = "cron-secret-value-123";
    process.env.INSTINCT_CRON_SECRET = "other-cron-secret-456";
    expect(await forcefieldAuthenticated(withHeaders({ authorization: "Bearer cron-secret-value-123" }))).toBe(true);
    expect(await forcefieldAuthenticated(withHeaders({ authorization: "Bearer other-cron-secret-456" }))).toBe(true);
    expect(await forcefieldAuthenticated(withHeaders({ authorization: "Bearer cron-secret-value-124" }))).toBe(false);
  });
  it("FACTORY_SERVICE_TOKEN in x-factory-token verifies (>=16 chars only)", async () => {
    process.env.FACTORY_SERVICE_TOKEN = "f".repeat(20);
    expect(await forcefieldAuthenticated(withHeaders({ "x-factory-token": "f".repeat(20) }))).toBe(true);
    expect(await forcefieldAuthenticated(withHeaders({ "x-factory-token": "f".repeat(19) }))).toBe(false);
    process.env.FACTORY_SERVICE_TOKEN = "short";
    expect(await forcefieldAuthenticated(withHeaders({ "x-factory-token": "short" }))).toBe(false);
  });
  it("the synthetic-monitor header verifies through the SHARED helper", async () => {
    process.env.FORCEFIELD_SYNTHETIC_TOKEN = "t".repeat(40);
    expect(await forcefieldAuthenticated(withHeaders({ "x-forcefield-synthetic": "t".repeat(40) }))).toBe(true);
    expect(await forcefieldAuthenticated(withHeaders({ "x-forcefield-synthetic": "t".repeat(39) }))).toBe(false);
  });

  describe("wired into the guard + monitor", () => {
    const PW = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0 Safari/537.36", accept: "application/json", "accept-language": "en-US", "accept-encoding": "gzip" };
    const fpWithAuth = operatorFingerprint(Array.from(new Headers({ ...PW, authorization: "x" }).keys()), "HeadlessChrome", "headless");
    beforeEach(() => {
      _resetRulesetCache();
      process.env.FORCEFIELD_WEB = "on";
      process.env.FORCEFIELD_ENFORCE = "on";
      process.env.FORCEFIELD_RULESET_URL = "https://wolfpack-instinct.vercel.app/api/forcefield/ruleset";
      jest.spyOn(global, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ ruleset: { ...DEFAULT_RULESET, blockedFingerprints: [fpWithAuth] } }), { status: 200 }));
    });
    afterEach(() => { delete process.env.FORCEFIELD_RULESET_URL; jest.restoreAllMocks(); _resetRulesetCache(); });

    it("our signed-in headless E2E is NOT blocked by an admin-blocked headless fingerprint", async () => {
      const r = new NextRequest("https://wolfpack-instinct.vercel.app/api/ms/chats/unread-count", { headers: { ...PW, authorization: `Bearer ${jwt()}` } });
      const res = await middleware(r, ev().event);
      expect(res.status).not.toBe(403);
    });
    it("the same headless request with a FORGED bearer IS blocked", async () => {
      const r = new NextRequest("https://wolfpack-instinct.vercel.app/api/ms/chats/unread-count", { headers: { ...PW, authorization: "Bearer forged.token.value" } });
      const res = await middleware(r, ev().event);
      expect(res.status).toBe(403);
      expect(res.headers.get("x-forcefield")).toBe("blocked:blocked_fingerprint");
    });
    it("a signed-in request carrying a payload is still blocked", async () => {
      const r = new NextRequest("https://wolfpack-instinct.vercel.app/search?q=%3Cscript%3Ealert(1)%3C/script%3E", { headers: { ...PW, authorization: `Bearer ${jwt()}` } });
      expect((await middleware(r, ev().event)).status).toBe(403);
    });
  });
});
