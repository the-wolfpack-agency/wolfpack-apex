/** @jest-environment node */
/**
 * Middleware safety proof. The Forcefield self-defense is now the shared shim,
 * invoked only via waitUntil and only when enabled. The middleware must still set
 * every security header, and must register the shim ONLY when FORCEFIELD_WEB is on
 * - dark by default, never touching the response.
 */
const startSpan = jest.fn(() => ({ end: jest.fn() }));
jest.mock("@/lib/obs", () => ({ getObsClient: () => ({ startSpan }) }));

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

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
