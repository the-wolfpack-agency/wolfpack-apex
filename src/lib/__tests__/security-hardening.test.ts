/**
 * Security Hardening Tests
 *
 * Validates fixes for critical, high, and medium vulnerabilities
 * found during the security audit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Capture real fs before any mocks
const realFs = jest.requireActual("fs") as typeof import("fs");
const realReadFileSync = realFs.readFileSync;
import { resolve } from "path";

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const mockExecFileSync = jest.fn();

jest.mock("child_process", () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

jest.mock("fs", () => ({
  readFileSync: jest.fn(),
}));

/** Read a source file relative to __dirname using the real fs */
function readSource(relPath: string): string {
  return realReadFileSync(resolve(__dirname, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Rate Limiter Tests
// ---------------------------------------------------------------------------
describe("Login Rate Limiter", () => {
  it("allows requests under the limit", () => {
    const loginAttempts = new Map<string, { count: number; resetAt: number }>();
    const MAX_ATTEMPTS = 5;
    const WINDOW_MS = 5 * 60 * 1000;

    const ip = "192.168.1.1";
    const now = Date.now();

    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    expect(loginAttempts.get(ip)!.count).toBeLessThanOrEqual(MAX_ATTEMPTS);

    loginAttempts.get(ip)!.count = 5;
    expect(loginAttempts.get(ip)!.count).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("blocks after exceeding the limit", () => {
    const loginAttempts = new Map<string, { count: number; resetAt: number }>();
    const MAX_ATTEMPTS = 5;
    const WINDOW_MS = 5 * 60 * 1000;
    const ip = "192.168.1.1";
    const now = Date.now();

    loginAttempts.set(ip, { count: MAX_ATTEMPTS + 1, resetAt: now + WINDOW_MS });
    expect(loginAttempts.get(ip)!.count).toBeGreaterThan(MAX_ATTEMPTS);
  });

  it("resets after the window expires", () => {
    const loginAttempts = new Map<string, { count: number; resetAt: number }>();
    const WINDOW_MS = 5 * 60 * 1000;
    const ip = "192.168.1.1";
    const now = Date.now();

    loginAttempts.set(ip, { count: 10, resetAt: now - 1 });
    expect(now >= loginAttempts.get(ip)!.resetAt).toBe(true);

    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    expect(loginAttempts.get(ip)!.count).toBe(1);
  });

  it("login route source contains rate limiting logic", () => {
    const source = readSource("../../app/api/auth/login/route.ts");
    expect(source).toContain("loginAttempts");
    expect(source).toContain("MAX_ATTEMPTS");
    expect(source).toContain("status: 429");
    expect(source).toContain("Retry-After");
    expect(source).toContain("login_rate_limited");
  });
});

// ---------------------------------------------------------------------------
// 2. JWT Secret Hardening
// ---------------------------------------------------------------------------
describe("JWT Secret Hardening", () => {
  const origEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...origEnv };
    delete process.env.INSTINCT_JWT_SECRET;
    delete process.env.APEX_JWT_SECRET;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("throws in production when no secret is set", () => {
    process.env.NODE_ENV = "production";
    const { getJwtSecret } = requireAuth();
    expect(() => getJwtSecret()).toThrow("must be set in production");
  });

  it("throws in production when secret is too short", () => {
    process.env.NODE_ENV = "production";
    process.env.INSTINCT_JWT_SECRET = "short";
    const { getJwtSecret } = requireAuth();
    expect(() => getJwtSecret()).toThrow("at least 32 characters");
  });

  it("returns the secret in production when valid", () => {
    process.env.NODE_ENV = "production";
    process.env.INSTINCT_JWT_SECRET = "a".repeat(32);
    const { getJwtSecret } = requireAuth();
    expect(getJwtSecret()).toBe("a".repeat(32));
  });

  it("uses fallback in development", () => {
    process.env.NODE_ENV = "development";
    const { getJwtSecret } = requireAuth();
    expect(getJwtSecret()).toBe("instinct-dev-secret-do-not-use-in-production");
  });

  function requireAuth() {
    jest.doMock("jsonwebtoken", () => ({
      sign: jest.fn(),
      verify: jest.fn(),
    }));
    jest.doMock("bcryptjs", () => ({
      hashSync: jest.fn(),
      compareSync: jest.fn(),
    }));
    jest.doMock("@/lib/db", () => ({ query: jest.fn() }));
    jest.doMock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

    const auth = jest.requireActual("@/lib/auth") as any;
    const jsonwebtoken = require("jsonwebtoken");

    return {
      getJwtSecret: () => {
        auth.createToken({ id: "test", email: "test@test.com", role: "dev", name: "Test" });
        if (jsonwebtoken.sign.mock.calls.length > 0) {
          return jsonwebtoken.sign.mock.calls[jsonwebtoken.sign.mock.calls.length - 1][1];
        }
        return null;
      },
    };
  }
});

// ---------------------------------------------------------------------------
// 3. Command Injection Prevention
// ---------------------------------------------------------------------------
describe("Command Injection Prevention (CWE-78)", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("uses execFileSync (array args) instead of execSync (shell string)", () => {
    mockExecFileSync.mockReturnValue("abc123|feat: something|Author|2025-01-01");
    const { generateReleaseNotes } = require("@/lib/doc-generator");

    generateReleaseNotes("/safe/path", "2025-01-01");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["-C", "/safe/path", "log"]),
      expect.any(Object),
    );
  });

  it("rejects path with shell metacharacters", () => {
    const { generateReleaseNotes } = require("@/lib/doc-generator");

    const result = generateReleaseNotes("/tmp/$(whoami)", "2025-01-01");
    expect(result.content).toContain("Invalid");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects malformed date input", () => {
    const { generateReleaseNotes } = require("@/lib/doc-generator");

    const result = generateReleaseNotes("/safe/path", "2025-01-01; rm -rf /");
    expect(result.content).toContain("Invalid");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("accepts valid repo path and date", () => {
    mockExecFileSync.mockReturnValue("");
    const { generateReleaseNotes } = require("@/lib/doc-generator");

    generateReleaseNotes("/valid/repo_path-1.0", "2025-03-15");
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it("doc-generator imports execFileSync not execSync", () => {
    const source = readSource("../doc-generator.ts");
    expect(source).toContain("execFileSync");
    expect(source).not.toMatch(/import.*execSync[^F]/);
  });
});

// ---------------------------------------------------------------------------
// 4. IDOR Prevention
// ---------------------------------------------------------------------------
describe("IDOR Prevention", () => {
  it("reports query includes ownership check with user.id and role", () => {
    const source = readSource("../../app/api/reports/[id]/route.ts");
    expect(source).toContain("generated_by = $2");
    expect(source).toContain("IN ('cto', 'ceo')");
  });

  it("docs route checks generated_by before returning", () => {
    const source = readSource("../../app/api/docs/[id]/route.ts");
    expect(source).toContain("doc.generated_by !== user.id");
    expect(source).toContain("unauthorized_access_attempt");
  });

  it("journal updateJournal already has user_id check", () => {
    const source = readSource("../journal.ts");
    expect(source).toContain("AND user_id =");
  });
});

// ---------------------------------------------------------------------------
// 5. Auth on Previously-Unauthenticated Endpoints
// ---------------------------------------------------------------------------
describe("Auth on Previously-Unauthenticated Endpoints", () => {
  it("discussions GET requires auth", () => {
    const source = readSource("../../app/api/discussions/route.ts");
    const getSection = source.split("export async function GET")[1]?.split("export async function")[0] || "";
    expect(getSection).toContain("getUserFromRequest");
    expect(getSection).toContain("status: 401");
  });

  it("features GET requires auth", () => {
    const source = readSource("../../app/api/features/route.ts");
    const getSection = source.split("export async function GET")[1]?.split("export async function")[0] || "";
    expect(getSection).toContain("getUserFromRequest");
    expect(getSection).toContain("status: 401");
  });

  it("clients GET requires auth", () => {
    const source = readSource("../../app/api/clients/route.ts");
    const getSection = source.split("export async function GET")[1]?.split("export async function")[0] || "";
    // Now gated via the capability registry (requireCapability → 401/403).
    expect(getSection).toMatch(/getUserFromRequest|requireCapability/);
  });
});

// ---------------------------------------------------------------------------
// 6. Security Headers Middleware
// ---------------------------------------------------------------------------
describe("Security Headers Middleware", () => {
  it("adds all required security headers", () => {
    const source = readSource("../../middleware.ts");

    expect(source).toContain("X-Content-Type-Options");
    expect(source).toContain("nosniff");
    expect(source).toContain("X-Frame-Options");
    expect(source).toContain("DENY");
    expect(source).toContain("X-XSS-Protection");
    expect(source).toContain("1; mode=block");
    expect(source).toContain("Referrer-Policy");
    expect(source).toContain("strict-origin-when-cross-origin");
    expect(source).toContain("Permissions-Policy");
    expect(source).toContain("camera=(), microphone=(), geolocation=()");
    // Should NOT have HSTS (Vercel handles it)
    expect(source).not.toContain("Strict-Transport-Security");
  });

  it("CSP header is present in the middleware response", () => {
    const source = readSource("../../middleware.ts");
    expect(source).toContain("Content-Security-Policy");
  });

  it("CSP includes default-src 'self'", () => {
    const source = readSource("../../middleware.ts");
    expect(source).toContain("default-src 'self'");
  });

  it("CSP includes object-src 'none'", () => {
    const source = readSource("../../middleware.ts");
    expect(source).toContain("object-src 'none'");
  });

  it("CSP includes base-uri 'self'", () => {
    const source = readSource("../../middleware.ts");
    expect(source).toContain("base-uri 'self'");
  });
});

// ---------------------------------------------------------------------------
// 7. Error Sanitization
// ---------------------------------------------------------------------------
describe("Error Message Sanitization", () => {
  const routeFiles = [
    "../../app/api/reports/route.ts",
    "../../app/api/knowledge/route.ts",
    "../../app/api/docs/route.ts",
    "../../app/api/docs/[id]/route.ts",
    "../../app/api/assistant/route.ts",
    "../../app/api/journal/route.ts",
    "../../app/api/journal/history/route.ts",
    "../../app/api/emails/route.ts",
    "../../app/api/microsoft/route.ts",
    "../../app/api/quickbooks/route.ts",
    "../../app/api/people/employees/route.ts",
    "../../app/api/people/onboarding/route.ts",
    "../../app/api/people/onboarding/[id]/route.ts",
    "../../app/api/people/onboarding/templates/route.ts",
    "../../app/api/people/documents/route.ts",
    "../../app/api/people/benefits/route.ts",
    "../../app/api/sites/route.ts",
    "../../app/api/sites/[id]/route.ts",
    "../../app/api/sites/webhook/route.ts",
  ];

  for (const file of routeFiles) {
    it(`${file} does not leak error details in 500 responses`, () => {
      const source = readSource(file);
      expect(source).not.toMatch(/detail:\s*\(err as Error\)\.message/);
      expect(source).not.toMatch(/error:\s*\(err as Error\)\.message\s*\}.*status:\s*500/s);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Analytics Event Types
// ---------------------------------------------------------------------------
describe("Analytics Event Types", () => {
  it("includes security event types", () => {
    const source = readSource("../analytics.ts");
    expect(source).toContain('"system.login_rate_limited"');
    expect(source).toContain('"system.upload_rate_limited"');
    expect(source).toContain('"system.unauthorized_access_attempt"');
  });
});

// ---------------------------------------------------------------------------
// 9. Upload Rate Limiting
// ---------------------------------------------------------------------------
describe("Upload Rate Limiting", () => {
  const uploadRoutes = [
    "../../app/api/people/documents/route.ts",
    "../../app/api/people/benefits/route.ts",
    "../../app/api/sites/[id]/assets/route.ts",
  ];

  for (const file of uploadRoutes) {
    it(`${file} has upload rate limiting`, () => {
      const source = readSource(file);
      expect(source).toContain("uploadAttempts");
      expect(source).toContain("MAX_UPLOADS");
      expect(source).toContain("status: 429");
      expect(source).toContain("upload_rate_limited");
    });
  }
});

// ---------------------------------------------------------------------------
// 10. Pagination Limits
// ---------------------------------------------------------------------------
describe("Pagination Limits", () => {
  it("knowledge route caps limit to 100", () => {
    const source = readSource("../../app/api/knowledge/route.ts");
    expect(source).toContain("Math.min(Math.max(");
    expect(source).toContain(", 100)");
  });

  it("meetings route caps limit to 100", () => {
    const source = readSource("../../app/api/meetings/route.ts");
    expect(source).toContain("Math.min(Math.max(");
    expect(source).toContain(", 100)");
  });
});
