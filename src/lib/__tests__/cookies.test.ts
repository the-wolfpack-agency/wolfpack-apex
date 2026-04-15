/**
 * Cookie helper tests.
 *
 * Verifies that setAuthCookie:
 *   - Sets httpOnly = true always
 *   - Sets secure = true in production, false in dev
 *   - SameSite defaults to Lax, can be overridden to Strict
 *   - path = "/"
 *   - maxAge matches provided seconds
 *   - clearAuthCookie sets Max-Age 0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  setAuthCookie,
  clearAuthCookie,
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/crypto/cookies";

const origEnv = process.env;

// Minimal NextResponse cookies mock
function makeMockResponse() {
  const calls: Record<string, any> = {};
  return {
    cookies: {
      set: jest.fn((name: string, value: string, opts: any) => {
        calls[name] = { value, ...opts };
      }),
    },
    _calls: calls,
  };
}

afterAll(() => {
  process.env = origEnv;
});

// ---------------------------------------------------------------------------
// Production flags
// ---------------------------------------------------------------------------
describe("setAuthCookie — production", () => {
  beforeEach(() => {
    process.env = { ...origEnv, NODE_ENV: "production" };
  });

  it("sets httpOnly = true", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].httpOnly).toBe(true);
  });

  it("sets secure = true in production", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].secure).toBe(true);
  });

  it("sets default sameSite = lax for session cookies", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].sameSite).toBe("lax");
  });

  it("sets sameSite = strict for refresh-token cookies", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, REFRESH_TOKEN_COOKIE, "rtok", REFRESH_TOKEN_TTL_SECONDS, { sameSite: "Strict" });
    expect(res._calls[REFRESH_TOKEN_COOKIE].sameSite).toBe("strict");
  });

  it("sets path = /", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].path).toBe("/");
  });

  it("sets maxAge matching provided seconds", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", 1234);
    expect(res._calls[ACCESS_TOKEN_COOKIE].maxAge).toBe(1234);
  });

  it("access token maxAge constant is 900", () => {
    expect(ACCESS_TOKEN_TTL).toBe(900);
  });

  it("refresh token maxAge constant is 604800", () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(604800);
  });
});

// ---------------------------------------------------------------------------
// Development flags — Secure is off
// ---------------------------------------------------------------------------
describe("setAuthCookie — development", () => {
  beforeEach(() => {
    process.env = { ...origEnv, NODE_ENV: "development" };
  });

  it("sets secure = false in development", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].secure).toBe(false);
  });

  it("still sets httpOnly = true in development", () => {
    const res = makeMockResponse();
    setAuthCookie(res as any, ACCESS_TOKEN_COOKIE, "tok", ACCESS_TOKEN_TTL);
    expect(res._calls[ACCESS_TOKEN_COOKIE].httpOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearAuthCookie
// ---------------------------------------------------------------------------
describe("clearAuthCookie", () => {
  it("sets maxAge = 0 to expire the cookie", () => {
    process.env = { ...origEnv, NODE_ENV: "production" };
    const res = makeMockResponse();
    clearAuthCookie(res as any, ACCESS_TOKEN_COOKIE);
    expect(res._calls[ACCESS_TOKEN_COOKIE].maxAge).toBe(0);
    expect(res._calls[ACCESS_TOKEN_COOKIE].value).toBe("");
  });

  it("sets httpOnly = true when clearing", () => {
    const res = makeMockResponse();
    clearAuthCookie(res as any, ACCESS_TOKEN_COOKIE);
    expect(res._calls[ACCESS_TOKEN_COOKIE].httpOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cookie name constants
// ---------------------------------------------------------------------------
describe("Cookie name constants", () => {
  it("ACCESS_TOKEN_COOKIE is instinct_access_token", () => {
    expect(ACCESS_TOKEN_COOKIE).toBe("instinct_access_token");
  });

  it("REFRESH_TOKEN_COOKIE is instinct_refresh_token", () => {
    expect(REFRESH_TOKEN_COOKIE).toBe("instinct_refresh_token");
  });
});
