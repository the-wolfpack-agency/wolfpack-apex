/**
 * Security headers tests for Wolfpack Instinct.
 *
 * Asserts:
 *   - CSP is enforced (no Content-Security-Policy-Report-Only header)
 *   - HSTS max-age >= 31536000, includeSubDomains, preload present
 *   - All secondary headers present with correct values
 *   - No unsafe-eval in script-src
 *   - report-uri points at /api/csp-report
 */

import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

// We test the middleware directly by importing and invoking it.
// NODE_ENV is "test" in jest so IS_PROD will be false — HSTS won't be set.
// We test HSTS separately by patching NODE_ENV.

describe("middleware security headers", () => {
  async function getHeaders(env: string = "test"): Promise<Headers> {
    const original = process.env.NODE_ENV;
    // @ts-expect-error — override readonly NODE_ENV for test
    process.env.NODE_ENV = env;
    // Re-import fresh module to pick up NODE_ENV change
    jest.resetModules();
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://instinct.wolfpackagency.com/");
    const res = middleware(req) as NextResponse;
    // @ts-expect-error
    process.env.NODE_ENV = original;
    return res.headers;
  }

  it("sets Content-Security-Policy (enforced, not report-only)", async () => {
    const headers = await getHeaders();
    expect(headers.get("Content-Security-Policy")).toBeTruthy();
    expect(headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("CSP does not contain unsafe-eval", async () => {
    const headers = await getHeaders();
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("unsafe-eval");
  });

  it("CSP contains report-uri /api/csp-report", async () => {
    const headers = await getHeaders();
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const headers = await getHeaders();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const headers = await getHeaders();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const headers = await getHeaders();
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets Permissions-Policy", async () => {
    const headers = await getHeaders();
    const pp = headers.get("Permissions-Policy") ?? "";
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
  });

  it("does NOT set HSTS in non-production", async () => {
    const headers = await getHeaders("test");
    expect(headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("sets HSTS in production with max-age >= 31536000, includeSubDomains, preload", async () => {
    const headers = await getHeaders("production");
    const hsts = headers.get("Strict-Transport-Security") ?? "";
    expect(hsts).toBeTruthy();

    const maxAgeMatch = hsts.match(/max-age=(\d+)/);
    expect(maxAgeMatch).not.toBeNull();
    const maxAge = parseInt(maxAgeMatch![1], 10);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);

    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");
  });
});
