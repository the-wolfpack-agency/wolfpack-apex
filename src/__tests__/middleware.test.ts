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

const ORIG = process.env.FORCEFIELD_WEB;
afterEach(() => { if (ORIG === undefined) delete process.env.FORCEFIELD_WEB; else process.env.FORCEFIELD_WEB = ORIG; });

describe("middleware - security headers always applied", () => {
  it("sets CSP and hardening headers on every response", () => {
    const { event } = ev();
    const res = middleware(req("/dashboard"), event);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("Forcefield self-defense (shim invocation)", () => {
  it("is DARK by default: FORCEFIELD_WEB unset -> no shim registered, response intact", () => {
    delete process.env.FORCEFIELD_WEB;
    const { event, waited } = ev();
    const res = middleware(req("/", "sqlmap/1"), event);
    expect(waited).toHaveLength(0);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("when ON: registers the shim via waitUntil and still returns the response (never blocks)", () => {
    process.env.FORCEFIELD_WEB = "on";
    const { event, waited } = ev();
    const res = middleware(req("/", "sqlmap/1"), event);
    expect(waited).toHaveLength(1); // the monitor promise, handed to waitUntil
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
