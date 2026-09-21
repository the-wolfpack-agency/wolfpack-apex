/** @jest-environment node */
/**
 * Middleware safety proof. The Forcefield self-defense block must be DARK by
 * default, MONITOR-ONLY, and FAIL-OPEN: it can never alter or block a request,
 * and a bug in it can never break the host. These tests lock all three.
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

const ORIG = { ff: process.env.FORCEFIELD_WEB, tok: process.env.SITE_ANALYTICS_INGEST_TOKEN, url: process.env.FORCEFIELD_INGEST_URL };
afterEach(() => {
  process.env.FORCEFIELD_WEB = ORIG.ff;
  process.env.SITE_ANALYTICS_INGEST_TOKEN = ORIG.tok;
  if (ORIG.url === undefined) delete process.env.FORCEFIELD_INGEST_URL; else process.env.FORCEFIELD_INGEST_URL = ORIG.url;
  jest.restoreAllMocks();
});

describe("middleware - security headers always applied", () => {
  it("sets CSP and the hardening headers on every response", () => {
    const { event } = ev();
    const res = middleware(req("/dashboard"), event);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("Forcefield self-defense block", () => {
  it("is DARK by default: FORCEFIELD_WEB unset -> never forwards, request untouched", () => {
    delete process.env.FORCEFIELD_WEB;
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const { event, waited } = ev();
    const res = middleware(req("/", "EvilScraper/9 (bot)"), event);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(waited).toHaveLength(0);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy(); // response intact
  });

  it("when ON: forwards a flagged bot to the ingest (monitor-only) and still returns the response", () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
    process.env.FORCEFIELD_INGEST_URL = "https://wolfpack-instinct.vercel.app/api/site-analytics/ingest";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const { event, waited } = ev();
    const res = middleware(req("/", "EvilScraper/9 (bot)"), event);
    // request is never blocked - a normal Next response with headers comes back
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    // the forward fired fire-and-forget via waitUntil
    expect(waited).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    // uses the CONFIGURED url, never one derived from the request (SSRF-safe)
    expect(String(url)).toBe("https://wolfpack-instinct.vercel.app/api/site-analytics/ingest");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ "x-ingest-token": "secret-token" });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ type: "site.agent_flagged", props: { surface: "instinct", blocked: false } });
  });

  it("when ON: a normal visitor forwards nothing", () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
    process.env.FORCEFIELD_INGEST_URL = "https://wolfpack-instinct.vercel.app/api/site-analytics/ingest";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const { event } = ev();
    middleware(req("/dashboard", "Mozilla/5.0 (Macintosh)"), event);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when ON but no ingest token: does not forward (fails safe, request intact)", () => {
    process.env.FORCEFIELD_WEB = "on";
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    process.env.FORCEFIELD_INGEST_URL = "https://wolfpack-instinct.vercel.app/api/site-analytics/ingest";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const { event } = ev();
    const res = middleware(req("/", "EvilScraper/9 (bot)"), event);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("when ON but no configured ingest URL: does not forward (never derives it from the request - SSRF-safe)", () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
    delete process.env.FORCEFIELD_INGEST_URL;
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const { event } = ev();
    const res = middleware(req("/", "EvilScraper/9 (bot)"), event);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("is FAIL-OPEN: even if the forward throws synchronously, the response still returns", () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
    process.env.FORCEFIELD_INGEST_URL = "https://wolfpack-instinct.vercel.app/api/site-analytics/ingest";
    jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("edge fetch blew up"); });
    const { event } = ev();
    // must not throw, must still return a response with headers
    const res = middleware(req("/", "EvilScraper/9 (bot)"), event);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
