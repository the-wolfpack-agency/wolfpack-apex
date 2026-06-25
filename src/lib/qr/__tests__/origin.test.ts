import { resolvePublicOrigin, resolveInternalOrigin } from "@/lib/qr/origin";

const SAVED = {
  QR_PUBLIC_ORIGIN: process.env.QR_PUBLIC_ORIGIN,
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  VERCEL_URL: process.env.VERCEL_URL,
  NODE_ENV: process.env.NODE_ENV,
};

beforeEach(() => {
  delete process.env.QR_PUBLIC_ORIGIN;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakeReq(url: string): Request {
  return new Request(url);
}

describe("resolvePublicOrigin", () => {
  test("QR_PUBLIC_ORIGIN (branded host) wins over everything else", () => {
    process.env.QR_PUBLIC_ORIGIN = "https://go.ogiam.com/";
    process.env.NEXT_PUBLIC_BASE_URL = "https://wolfpack-instinct.vercel.app";
    expect(resolvePublicOrigin(fakeReq("https://x/api/qr"))).toBe("https://go.ogiam.com");
  });

  test("a malformed QR_PUBLIC_ORIGIN is ignored (falls through to canonical)", () => {
    process.env.QR_PUBLIC_ORIGIN = "go.ogiam.com"; // missing scheme
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com";
    expect(resolvePublicOrigin(fakeReq("https://x/y"))).toBe("https://example.com");
  });

  test("uses NEXT_PUBLIC_BASE_URL when set", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com";
    expect(resolvePublicOrigin(fakeReq("https://other.com/api/qr"))).toBe(
      "https://example.com",
    );
  });

  test("strips trailing slashes from NEXT_PUBLIC_BASE_URL", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com/";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://example.com",
    );
  });

  test("prefers VERCEL_PROJECT_PRODUCTION_URL over VERCEL_URL (the per-deployment URL is auth-gated)", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "wolfpack-instinct.vercel.app";
    process.env.VERCEL_URL = "wolfpack-instinct-kua7jbj5f-nhomyks-projects.vercel.app";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://wolfpack-instinct.vercel.app",
    );
  });

  test("uses VERCEL_BRANCH_URL when production URL absent", () => {
    process.env.VERCEL_BRANCH_URL = "wolfpack-instinct-git-main.vercel.app";
    process.env.VERCEL_URL = "wolfpack-instinct-deadbeef.vercel.app";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://wolfpack-instinct-git-main.vercel.app",
    );
  });

  test("falls back to VERCEL_URL only when no public alias exists", () => {
    process.env.VERCEL_URL = "wolfpack-instinct.vercel.app";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://wolfpack-instinct.vercel.app",
    );
  });

  test("falls back to request origin when no env is set", () => {
    expect(
      resolvePublicOrigin(fakeReq("https://wolfpack-instinct.vercel.app/api/qr")),
    ).toBe("https://wolfpack-instinct.vercel.app");
  });

  test("NEVER returns a relative path (regression: phone cameras Google-search relative QR payloads)", () => {
    const out = resolvePublicOrigin(
      fakeReq("https://wolfpack-instinct.vercel.app/api/qr"),
    );
    expect(out.startsWith("http")).toBe(true);
  });
});

describe("resolveInternalOrigin (server self-calls — never trusts the request)", () => {
  test("uses NEXT_PUBLIC_BASE_URL when set", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com/";
    expect(resolveInternalOrigin()).toBe("https://example.com");
  });

  test("IGNORES QR_PUBLIC_ORIGIN (the branded QR host must never become a self-call target)", () => {
    process.env.QR_PUBLIC_ORIGIN = "https://go.ogiam.com";
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com";
    // Internal self-calls forward the caller's bearer; they must trust only the
    // canonical origin, not the public QR host (SSRF / token-exfil defense).
    expect(resolveInternalOrigin()).toBe("https://example.com");
  });

  test("prefers the production alias over the per-deployment VERCEL_URL", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "wolfpack-instinct.vercel.app";
    process.env.VERCEL_URL = "wolfpack-instinct-deadbeef.vercel.app";
    expect(resolveInternalOrigin()).toBe("https://wolfpack-instinct.vercel.app");
  });

  test("falls back to localhost in dev when no env is configured", () => {
    process.env.NODE_ENV = "development";
    expect(resolveInternalOrigin()).toBe("http://localhost:3000");
  });

  test("throws in production when no trusted origin is configured (refuses to call an untrusted host)", () => {
    process.env.NODE_ENV = "production";
    expect(() => resolveInternalOrigin()).toThrow(/internal origin/i);
  });
});
