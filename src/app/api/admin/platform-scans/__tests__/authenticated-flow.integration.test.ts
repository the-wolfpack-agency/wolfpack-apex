/**
 * DETERMINISTIC integration e2e for the authenticated client-onboarding scan flow,
 * driven THROUGH THE REAL run route with only the true external boundaries mocked.
 *
 * Unlike route.test.ts (which mocks resolveScanTarget / establishSession /
 * scanPlatform individually), this test exercises the REAL internals end to end:
 *   resolveScanTarget (manifests)  -> falls to the saved-connection path
 *     -> establishSession (session) -> logs in, extracts the session cookie
 *     -> discoverRoutes (discover)   -> no sitemap, falls to the default routes
 *     -> scanPlatform / classify (engine) -> authenticated crawl semantics
 *     -> recordScan (store)          -> persists header + per-finding rows,
 *                                       tracks completion, feeds Brain learning.
 *
 * Only the genuine boundaries are mocked: the capability gate, the credential
 * store, the DB, analytics, the Brain ingest, the audit log, and global fetch
 * (the network to the external target). Everything BETWEEN those boundaries is
 * the real code, so the actual handoffs where integration bugs hide are proven.
 *
 * This is the always-on CI proof that "connect a client system with a
 * username/password -> the agent logs in -> scans it AUTHENTICATED -> findings
 * persist + feed learning" actually composes.
 */

// --- Boundary mocks ---------------------------------------------------------

// 1. Capability gate: always admin, ws-1.
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(async () => ({
    ok: true,
    user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
  })),
}));

// 2. Credential store: a username/password connection for "beyond-test" (NOT a
//    curated manifest, so resolveScanTarget falls to the connection path). The
//    list is empty so listScanTargets isn't relevant here.
const mockLoadCreds = jest.fn();
const mockListCreds = jest.fn(async () => [] as unknown[]);
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (ws: string, name: string) => mockLoadCreds(ws, name),
  listConnectorCredentials: (ws?: string) => mockListCreds(ws),
}));

// 3. DB: capture every writeQuery so we can assert the scan-header row + one row
//    per finding were persisted. The scan-header INSERT ... RETURNING id yields
//    scan-1; finding inserts yield no rows. safeQuery / query are inert.
const writeCalls: { sql: string; params: unknown[] }[] = [];
const mockWriteQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  writeCalls.push({ sql, params });
  if (/INSERT INTO instinct_platform_scans\b/i.test(sql)) {
    return { rows: [{ id: "scan-1" }] };
  }
  return { rows: [] };
});
jest.mock("@/lib/db", () => ({
  writeQuery: (sql: string, params: unknown[] = []) => mockWriteQuery(sql, params),
  safeQuery: jest.fn(async () => ({ rows: [] })),
  query: jest.fn(async () => ({ rows: [] })),
}));

// 4. Analytics: capture every trackEvent.
const trackCalls: { event: string; userId: string; role: string; meta: Record<string, unknown> }[] = [];
jest.mock("@/lib/analytics", () => ({
  trackEvent: (event: string, userId: string, role: string, meta: Record<string, unknown> = {}) => {
    trackCalls.push({ event, userId, role, meta });
  },
}));

// 5. Brain learning ingest: no-op, captured. (Mocking the module also keeps the
//    real @/lib/brain/ingest dependency tree out of the test.)
const ingestCalls: unknown[][] = [];
jest.mock("@/lib/platform-scan/brain-ingest", () => ({
  PLATFORM_SCAN_BRAIN_TAG: "platform-scan",
  ingestPlatformScanFinding: (...a: unknown[]) => {
    ingestCalls.push(a);
    return Promise.resolve();
  },
}));

// 6. Audit log: no-op + stub metadata.
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn(async () => undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

// REAL (NOT mocked): manifests, session, engine, discover, store.

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/route";

const BASE = "https://beyond.example";
const CONNECTION = {
  baseUrl: BASE,
  authType: "username_password" as const,
  username: "op@beyond.example",
  password: "pw",
  loginPath: "/api/auth/login",
  sessionCookieName: "session",
  isActive: true,
};

const SESSION_COOKIE = "session=SESSIONVAL";

/** The default-connection routes resolveScanTarget assigns when there is no
 *  sitemap: protected pages whose 200 must DEPEND on the session cookie. */
const PROTECTED = ["/dashboard", "/account", "/settings"];
const PUBLIC = ["/", "/login"];

/** Does this request init carry the session cookie? (the auth-crawl gate) */
function hasSessionCookie(init?: RequestInit): boolean {
  const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
  return typeof cookie === "string" && cookie.includes(SESSION_COOKIE);
}

function headersWith(map: Record<string, string | null>) {
  return {
    get: (h: string) => map[h.toLowerCase()] ?? null,
    getSetCookie: () => (map["set-cookie"] ? [map["set-cookie"]] : []),
  };
}

/** Build the fetch router. `protectedStatus` lets a test make a protected route
 *  fail (e.g. 500) while still requiring the session cookie to reach it. */
function buildFetch(protectedStatus: Record<string, number> = {}) {
  return jest.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.slice(BASE.length); // everything after the origin

    // Sitemap discovery: no sitemap -> default routes.
    if (path === "/sitemap.xml") {
      return { status: 404, ok: false, headers: headersWith({}), text: async () => "" };
    }

    // Login: issues the session cookie.
    if (path === "/api/auth/login" && init?.method === "POST") {
      return {
        status: 200,
        ok: true,
        headers: headersWith({ "set-cookie": "session=SESSIONVAL; HttpOnly; Path=/" }),
        text: async () => "",
      };
    }

    // Public routes: always 200, no auth needed.
    if (PUBLIC.includes(path)) {
      return { status: 200, ok: true, headers: headersWith({}), text: async () => "" };
    }

    // Protected routes: reachable (200, or an injected failure) ONLY with the
    // session cookie; otherwise bounced to /login (correct enforcement).
    if (PROTECTED.includes(path)) {
      if (!hasSessionCookie(init)) {
        return { status: 302, ok: false, headers: headersWith({ location: "/login" }), text: async () => "" };
      }
      const status = protectedStatus[path] ?? 200;
      const loc = status >= 300 && status < 400 ? "/somewhere" : null;
      return { status, ok: status >= 200 && status < 300, headers: headersWith({ location: loc }), text: async () => "" };
    }

    // Anything else: 404 (shouldn't happen with the default routes).
    return { status: 404, ok: false, headers: headersWith({}), text: async () => "" };
  });
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const findingInserts = () => writeCalls.filter((c) => /INSERT INTO instinct_platform_scan_findings\b/i.test(c.sql));
const scanHeaderInserts = () => writeCalls.filter((c) => /INSERT INTO instinct_platform_scans\b/i.test(c.sql));
const startedEvent = () => trackCalls.find((c) => c.event === "platform.scan_started");
const completedEvent = () => trackCalls.find((c) => c.event === "platform.scan_completed");

beforeEach(() => {
  jest.clearAllMocks();
  writeCalls.length = 0;
  trackCalls.length = 0;
  ingestCalls.length = 0;
  // DATABASE_URL gates trackEvent's real write, but trackEvent is mocked here.
  // loadConnectorCredentials is mocked too, so no env is required for the flow.
  mockLoadCreds.mockResolvedValue({ ...CONNECTION });
  mockListCreds.mockResolvedValue([]);
  // re-arm writeQuery routing after clearAllMocks reset the implementation.
  mockWriteQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    writeCalls.push({ sql, params });
    if (/INSERT INTO instinct_platform_scans\b/i.test(sql)) return { rows: [{ id: "scan-1" }] };
    return { rows: [] };
  });
});

describe("authenticated client-onboarding scan flow (real internals, boundaries mocked)", () => {
  it("logs in, crawls AUTHENTICATED, persists + learns, and raises NO false 'served without auth' findings", async () => {
    global.fetch = buildFetch() as unknown as typeof fetch;

    const res = await post({ platform: "beyond-test", mode: "http" });

    // 1. The route composed end to end: 200 with the expected envelope.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, platform: "beyond-test", mode: "http", scanId: "scan-1" });

    const fetchMock = global.fetch as unknown as jest.Mock;
    const calls = fetchMock.mock.calls as [string, RequestInit | undefined][];

    // 2. The login actually happened, POSTing { email, password } to the target.
    const loginCall = calls.find(([u, init]) => u === `${BASE}/api/auth/login` && init?.method === "POST");
    expect(loginCall).toBeDefined();
    expect(JSON.parse(String(loginCall![1]!.body))).toEqual({ email: "op@beyond.example", password: "pw" });

    // 3. The crawl was AUTHENTICATED: the protected-route probes carried the
    //    session cookie, and scan_started recorded authenticated:true.
    const protectedCall = calls.find(([u]) => u === `${BASE}/dashboard`);
    expect(protectedCall).toBeDefined();
    expect((protectedCall![1]?.headers as Record<string, string>).Cookie).toBe(SESSION_COOKIE);
    expect(startedEvent()?.meta).toMatchObject({ platform: "beyond-test", mode: "http", authenticated: true });

    // 4. Because the crawl was authenticated, the protected routes returning 200
    //    did NOT produce false "served content without auth" security findings.
    const findings = json.findings as { category: string; title: string }[];
    const falsePositive = findings.find(
      (f) => f.category === "security" && /without auth/i.test(f.title),
    );
    expect(falsePositive).toBeUndefined();
    // With every route healthy under auth, the clean crawl yields zero findings.
    expect(findings).toHaveLength(0);

    // 5. Learning tie-in: the scan header row was written, one row per finding,
    //    scan_completed was tracked, and Brain ingest ran once per finding.
    expect(scanHeaderInserts()).toHaveLength(1);
    expect(findingInserts()).toHaveLength(findings.length);
    expect(completedEvent()?.meta).toMatchObject({
      platform: "beyond-test",
      finding_count: findings.length,
    });
    expect(ingestCalls).toHaveLength(findings.length);
  });

  it("surfaces + persists a real critical/bug finding when an authenticated route 500s", async () => {
    // /dashboard 500s even WITH the session cookie -> a genuine bug, not a false
    // auth gap. Proves real findings still surface on an authenticated crawl.
    global.fetch = buildFetch({ "/dashboard": 500 }) as unknown as typeof fetch;

    const res = await post({ platform: "beyond-test", mode: "http" });
    expect(res.status).toBe(200);
    const json = await res.json();
    const findings = json.findings as { route: string; severity: string; category: string }[];

    // The 500 reached the route WITH the cookie (auth crawl), then classified as critical/bug.
    const fetchMock = global.fetch as unknown as jest.Mock;
    const dash = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([u]) => u === `${BASE}/dashboard`);
    expect((dash![1]?.headers as Record<string, string>).Cookie).toBe(SESSION_COOKIE);

    const bug = findings.find((f) => f.route === "/dashboard");
    expect(bug).toMatchObject({ severity: "critical", category: "bug" });

    // Still no false "served without auth" security finding on the other routes.
    expect(findings.find((f) => f.category === "security")).toBeUndefined();

    // The real finding persisted + fed learning.
    expect(scanHeaderInserts()).toHaveLength(1);
    expect(findingInserts()).toHaveLength(findings.length);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(ingestCalls).toHaveLength(findings.length);
    expect(json).toMatchObject({ ok: true, scanId: "scan-1", criticalCount: 1 });
  });
});
