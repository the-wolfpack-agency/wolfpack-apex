/**
 * END-TO-END onboard-to-scan integration proof for a Salesforce-style
 * (oauth_password) target. ONE test that walks the entire client-onboarding
 * chain with ONLY the true external boundaries mocked, asserting each stage:
 *
 *   1. ONBOARD   saveScanTarget persists a stored ScanManifest (the onboarding
 *                spine); resolveScanTarget reads it back. (targets-store +
 *                manifests, REAL: only the DB boundary is mocked.)
 *   2. PREFLIGHT runPreflight returns ok:true with every critical check green
 *                (target resolved, base URL public + reachable, login
 *                credentials present). Reachability is driven through
 *                deps.fetchImpl. (preflight, REAL.)
 *   3. AUTH      establishOAuthPasswordSession exchanges the client credential
 *                pair + user creds at /services/oauth2/token (mocked fetch) and
 *                returns a bearer + the per-org instance_url. We assert the
 *                token endpoint was called and the bearer/instance_url are then
 *                used by the scan. (session, REAL, driven via the route's
 *                resolveAuth.)
 *   4. SCAN      scanPlatform crawls the instance with the bearer header and a
 *                deliberately-vulnerable target response (an authenticated route
 *                that 500s) yields at least one finding. (engine, REAL.)
 *   5. DATA/LEARNING  recordScan persists the scan header + one row per finding,
 *                trackEvent fires platform.scan_started + platform.scan_completed
 *                + platform.scan_finding_detected, recordAudit records the
 *                "platform.scan_run" security event, and Brain ingest runs per
 *                finding. (store, REAL.)
 *
 * WHY THE ROUTE (lib-chain driven through POST), NOT the bare libs:
 *   The handoff where integration bugs actually hide is resolveAuth wiring the
 *   oauth_password bearer + per-org instance_url INTO scanPlatform (Authorization
 *   header, instance baseUrl). Driving the real POST route exercises
 *   resolveScanTarget -> resolveAuth -> establishOAuthPasswordSession ->
 *   scanPlatform -> recordScan with all internals REAL, so that wiring is proven,
 *   not stubbed. Only the genuine external boundaries are mocked: the capability
 *   gate, the DB, the connector credential load, analytics, audit, Brain ingest,
 *   the in-app notifier, the SSRF/DNS guard, and global fetch (the network to the
 *   token endpoint + the target). The sibling api/__tests__ test covers the
 *   username/password (cookie) variant; this is the oauth_password (bearer)
 *   variant plus the explicit onboard + preflight stages.
 *
 * Non-destructive: every external IO is mocked; no real network or DB is touched.
 */

// --- Boundary mocks (genuine external edges only) ---------------------------

// 1. Capability gate: always admin, ws-1.
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(async () => ({
    ok: true,
    user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
  })),
}));

// 2. DB boundary. safeQuery answers the stored-target SELECT (so resolveScanTarget
//    reads back the onboarded manifest); writeQuery captures every INSERT/UPDATE so
//    we can assert the onboarding upsert, the scan-header row, and one row per
//    finding were persisted. The scan-header INSERT ... RETURNING id yields scan-1.
const writeCalls: { sql: string; params: unknown[] }[] = [];
const safeCalls: { sql: string; params: unknown[] }[] = [];
let storedTargetRow: Record<string, unknown> | null = null;
const mockWriteQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  writeCalls.push({ sql, params });
  if (/INSERT INTO instinct_platform_scans\b/i.test(sql)) return { rows: [{ id: "scan-1" }] };
  return { rows: [] };
});
const mockSafeQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  safeCalls.push({ sql, params });
  if (/FROM instinct_scan_targets/i.test(sql)) {
    return { rows: storedTargetRow ? [storedTargetRow] : [] };
  }
  return { rows: [] };
});
jest.mock("@/lib/db", () => ({
  writeQuery: (sql: string, params: unknown[] = []) => mockWriteQuery(sql, params),
  safeQuery: (sql: string, params: unknown[] = []) => mockSafeQuery(sql, params),
  query: jest.fn(async () => ({ rows: [] })),
}));

// 3. Connector credential load: an oauth_password (Salesforce-style) connection.
//    resolveAuth reads this by manifest.login.connectorName and runs the REAL
//    OAuth token exchange against the (mocked) token endpoint.
const mockLoadCreds = jest.fn();
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (ws: string, name: string) => mockLoadCreds(ws, name),
  listConnectorCredentials: jest.fn(async () => []),
}));

// 4. Analytics: capture every trackEvent.
const trackCalls: { event: string; userId: string; role: string; meta: Record<string, unknown> }[] = [];
jest.mock("@/lib/analytics", () => ({
  trackEvent: (event: string, userId: string, role: string, meta: Record<string, unknown> = {}) => {
    trackCalls.push({ event, userId, role, meta });
  },
}));

// The onboarded Salesforce target is verified for this flow, so the fail-closed
// ownership gate passes (the gate itself is covered in the scan route test).
jest.mock("@/lib/platform-scan/authorization", () => ({
  isTargetVerified: () => Promise.resolve(true),
}));

// 5. Brain learning ingest: no-op, captured (also keeps the real ingest tree out).
const ingestCalls: unknown[][] = [];
jest.mock("@/lib/platform-scan/brain-ingest", () => ({
  PLATFORM_SCAN_BRAIN_TAG: "platform-scan",
  ingestPlatformScanFinding: (...a: unknown[]) => {
    ingestCalls.push(a);
    return Promise.resolve();
  },
}));

// 6. Audit log: capture recordAudit calls + stub request metadata.
const auditCalls: Record<string, unknown>[] = [];
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn(async (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  }),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

// 7. In-app notifier (store calls notify on a critical finding): no-op.
jest.mock("@/lib/notifications/in-app", () => ({
  notify: jest.fn(async () => undefined),
}));

// 8. SSRF/DNS guard: real assertScannableUrl resolves DNS; mock it so the test is
//    hermetic (no network). Matches the preflight test's mocking idiom.
const mockAssertUrl = jest.fn();
jest.mock("@/lib/platform-scan/ssrf-guard", () => {
  class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  }
  return {
    assertScannableUrl: (...a: unknown[]) => mockAssertUrl(...a),
    SsrfBlockedError,
  };
});

// REAL (NOT mocked): targets-store, manifests, preflight, session, engine,
// discover, store. The whole chain between the boundaries is the real code.

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/route";
import { saveScanTarget } from "@/lib/platform-scan/targets-store";
import { resolveScanTarget, type ScanManifest } from "@/lib/platform-scan/manifests";
import { runPreflight } from "@/lib/platform-scan/preflight";

const WORKSPACE = "ws-1";
const PLATFORM = "acme-salesforce"; // NOT a curated manifest -> the onboarded path.
const TOKEN_HOST = "https://test.salesforce.com";
const TOKEN_PATH = "/services/oauth2/token";
const INSTANCE_URL = "https://acme.my.salesforce.com";

// The Salesforce-style oauth_password connection resolveAuth loads + replays.
const SF_CONNECTION = {
  workspaceId: WORKSPACE,
  connectorName: PLATFORM,
  baseUrl: TOKEN_HOST,
  authType: "oauth_password" as const,
  clientId: "3MVG9client",
  clientSecret: "secret-shhh",
  username: "agent@acme.com",
  password: "pw+securitytoken",
  loginPath: TOKEN_PATH,
  isActive: true,
};

// The onboarded ScanManifest: token host as baseUrl, the oauth_password login
// config, and routes whose 200 must depend on the bearer (so an authenticated
// crawl is the only way to reach them).
const ONBOARD_MANIFEST: ScanManifest = {
  baseUrl: TOKEN_HOST,
  routes: [
    { path: "/", journey: "Home", auth: "public" },
    { path: "/dashboard", journey: "Dashboard", auth: "required" },
    { path: "/account", journey: "Account", auth: "required" },
  ],
  login: { connectorName: PLATFORM, loginPath: TOKEN_PATH, sessionCookieName: "" },
};

const BEARER = "Bearer 00Dxx!AR.token";
const PROTECTED = ["/dashboard", "/account"];
const PUBLIC = ["/"];

/** Does this request carry the bearer the OAuth exchange minted? */
function hasBearer(init?: RequestInit): boolean {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  return auth === BEARER;
}

// A well-configured target sends these on every response so the new security-header
// checks stay silent and the assertions stay focused on the auth + bug findings.
const SECURE_BASE: Record<string, string> = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=63072000",
};

function headersWith(map: Record<string, string | null>) {
  const merged: Record<string, string | null> = { ...SECURE_BASE, ...map };
  return {
    get: (h: string) => merged[h.toLowerCase()] ?? null,
    getSetCookie: () => (merged["set-cookie"] ? [merged["set-cookie"] as string] : []),
    forEach: (cb: (value: string, key: string) => void) => {
      for (const [k, v] of Object.entries(merged)) if (v != null) cb(v, k);
    },
  };
}

/**
 * Build the fetch router for BOTH the token endpoint and the target instance.
 * `protectedStatus` lets us drive a vulnerable response (e.g. 500) on an
 * authenticated route to force a real finding.
 */
/** Minimal Response-like shape the engine/session/discover code reads. */
interface MockResponse {
  status: number;
  ok: boolean;
  headers: ReturnType<typeof headersWith>;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
}

function buildFetch(protectedStatus: Record<string, number> = {}) {
  return jest.fn(async (input: string | URL, init?: RequestInit): Promise<MockResponse> => {
    const url = typeof input === "string" ? input : input.toString();

    // OAuth token exchange: trade the credential quad for a bearer + instance_url.
    if (url === `${TOKEN_HOST}${TOKEN_PATH}` && init?.method === "POST") {
      return {
        status: 200,
        ok: true,
        headers: headersWith({}),
        json: async () => ({
          access_token: "00Dxx!AR.token",
          instance_url: INSTANCE_URL,
        }),
        text: async () => "",
      };
    }

    // Everything else is the per-org INSTANCE the bearer is scoped to.
    const path = url.startsWith(INSTANCE_URL) ? url.slice(INSTANCE_URL.length) : url;

    // Sitemap discovery: no sitemap -> fall back to the onboarded routes.
    if (path === "/sitemap.xml") {
      return { status: 404, ok: false, headers: headersWith({}), text: async () => "" };
    }

    // Public routes: 200, no auth needed.
    if (PUBLIC.includes(path)) {
      return { status: 200, ok: true, headers: headersWith({}), text: async () => "" };
    }

    // Protected routes: reachable ONLY with the bearer; otherwise 401 (correct
    // enforcement). With the bearer, a 200 (healthy) or an injected failure.
    if (PROTECTED.includes(path)) {
      if (!hasBearer(init)) {
        return { status: 401, ok: false, headers: headersWith({}), text: async () => "" };
      }
      const status = protectedStatus[path] ?? 200;
      return { status, ok: status >= 200 && status < 300, headers: headersWith({}), text: async () => "" };
    }

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
const targetUpserts = () => writeCalls.filter((c) => /INSERT INTO instinct_scan_targets\b/i.test(c.sql));
const startedEvent = () => trackCalls.find((c) => c.event === "platform.scan_started");
const completedEvent = () => trackCalls.find((c) => c.event === "platform.scan_completed");
const findingEvents = () => trackCalls.filter((c) => c.event === "platform.scan_finding_detected");

beforeEach(() => {
  jest.clearAllMocks();
  writeCalls.length = 0;
  safeCalls.length = 0;
  trackCalls.length = 0;
  ingestCalls.length = 0;
  auditCalls.length = 0;
  storedTargetRow = null;
  mockAssertUrl.mockResolvedValue(undefined);
  mockLoadCreds.mockResolvedValue({ ...SF_CONNECTION });
  // re-arm DB routing after clearAllMocks reset the implementations.
  mockWriteQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    writeCalls.push({ sql, params });
    if (/INSERT INTO instinct_platform_scans\b/i.test(sql)) return { rows: [{ id: "scan-1" }] };
    return { rows: [] };
  });
  mockSafeQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    safeCalls.push({ sql, params });
    if (/FROM instinct_scan_targets/i.test(sql)) {
      return { rows: storedTargetRow ? [storedTargetRow] : [] };
    }
    return { rows: [] };
  });
});

describe("onboard -> preflight -> oauth_password auth -> scan -> persist/learn (REAL internals, boundaries mocked)", () => {
  it("walks the full Salesforce-style client-onboarding chain end to end", async () => {
    // ===== STAGE 1: ONBOARD =====================================================
    // Register the client system as a stored scan target (no code change). The
    // upsert hits the mocked DB; we then arm the stored-target SELECT to return it
    // so the REAL resolveScanTarget reads it back on the preflight + scan paths.
    await saveScanTarget(WORKSPACE, PLATFORM, ONBOARD_MANIFEST, "admin-1");

    const upsert = targetUpserts();
    expect(upsert).toHaveLength(1);
    expect(upsert[0].sql).toMatch(/ON CONFLICT \(workspace_id, platform\) DO UPDATE/);
    expect(upsert[0].params[0]).toBe(WORKSPACE);
    expect(upsert[0].params[1]).toBe(PLATFORM);
    expect(upsert[0].params[2]).toBe(JSON.stringify(ONBOARD_MANIFEST));

    // The store persisted the manifest as a JSON string; mimic the DB row so the
    // SELECT in resolveScanTarget round-trips the real onboarded config.
    storedTargetRow = { platform: PLATFORM, manifest: JSON.stringify(ONBOARD_MANIFEST), is_active: true };

    // resolveScanTarget (REAL) reads the onboarded target back, not a curated one.
    const resolved = await resolveScanTarget(WORKSPACE, PLATFORM);
    expect(resolved).toEqual(ONBOARD_MANIFEST);

    // ===== STAGE 2: PREFLIGHT ===================================================
    // Non-destructive readiness checks. Reachability is driven via deps.fetchImpl;
    // login_credentials passes because the oauth_password connection is loadable.
    const preflightFetch = jest.fn(async () => ({ status: 200 }) as unknown as Response);
    const preflight = await runPreflight(WORKSPACE, PLATFORM, {
      fetchImpl: preflightFetch as unknown as typeof fetch,
    });

    expect(preflight.ok).toBe(true);
    const check = (name: string) => preflight.checks.find((c) => c.name === name);
    expect(check("target_resolved")).toMatchObject({ pass: true, critical: true });
    expect(check("base_url_public")).toMatchObject({ pass: true, critical: true });
    expect(check("base_url_reachable")).toMatchObject({ pass: true, critical: true });
    expect(check("login_credentials")).toMatchObject({ pass: true, critical: true });
    // The reachability GET hit the onboarded base URL (the token host).
    expect(preflightFetch).toHaveBeenCalledWith(TOKEN_HOST, { method: "GET", redirect: "manual" });
    // Preflight loaded creds for the login connector (proves the credential wiring).
    expect(mockLoadCreds).toHaveBeenCalledWith(WORKSPACE, PLATFORM);

    // ===== STAGE 3 + 4 + 5: AUTH -> SCAN -> PERSIST/LEARN (through the route) ====
    // /dashboard 500s even WITH the bearer -> a genuine bug finding (not a false
    // auth gap), proving a real vulnerable response is detected on an
    // authenticated crawl.
    global.fetch = buildFetch({ "/dashboard": 500 }) as unknown as typeof fetch;

    const res = await post({ platform: PLATFORM, mode: "http" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, platform: PLATFORM, mode: "http", scanId: "scan-1" });

    const fetchMock = global.fetch as unknown as jest.Mock;
    const calls = fetchMock.mock.calls as [string, RequestInit | undefined][];

    // --- STAGE 3: AUTH ---
    // The OAuth token exchange happened: a form-urlencoded grant_type=password POST
    // to the token endpoint carrying the client credential pair + user creds.
    const tokenCall = calls.find(([u, init]) => u === `${TOKEN_HOST}${TOKEN_PATH}` && init?.method === "POST");
    expect(tokenCall).toBeDefined();
    expect((tokenCall![1]?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const sentBody = new URLSearchParams(String(tokenCall![1]!.body));
    expect(sentBody.get("grant_type")).toBe("password");
    expect(sentBody.get("client_id")).toBe(SF_CONNECTION.clientId);
    expect(sentBody.get("client_secret")).toBe(SF_CONNECTION.clientSecret);
    expect(sentBody.get("username")).toBe(SF_CONNECTION.username);

    // The bearer + per-org instance_url are USED: the protected probes hit the
    // INSTANCE host (not the token host) and carried the bearer Authorization.
    const dash = calls.find(([u]) => u === `${INSTANCE_URL}/dashboard`);
    expect(dash).toBeDefined();
    expect((dash![1]?.headers as Record<string, string>).Authorization).toBe(BEARER);
    const acct = calls.find(([u]) => u === `${INSTANCE_URL}/account`);
    expect(acct).toBeDefined();
    expect((acct![1]?.headers as Record<string, string>).Authorization).toBe(BEARER);
    // scan_started recorded the crawl as authenticated.
    expect(startedEvent()?.meta).toMatchObject({ platform: PLATFORM, mode: "http", authenticated: true });

    // --- STAGE 4: SCAN ---
    const findings = json.findings as { route: string; severity: string; category: string; title: string }[];
    // At least one finding from the vulnerable response.
    expect(findings.length).toBeGreaterThanOrEqual(1);
    // The 500 on the authenticated /dashboard classified as critical/bug.
    const bug = findings.find((f) => f.route === "/dashboard");
    expect(bug).toMatchObject({ severity: "critical", category: "bug" });
    // No FALSE "served content without auth" finding: the authenticated /account
    // 200 is expected-healthy, not an access-control gap.
    expect(findings.find((f) => f.category === "security" && /without auth/i.test(f.title))).toBeUndefined();
    expect(json).toMatchObject({ criticalCount: 1 });

    // --- STAGE 5: DATA / LEARNING TIE-IN ---
    // recordScan persisted the scan header + one row per finding.
    expect(scanHeaderInserts()).toHaveLength(1);
    expect(findingInserts()).toHaveLength(findings.length);
    // The scan-header row carried the platform + the instance baseUrl the bearer
    // operated against (proves the per-org instance_url flowed all the way to
    // persistence, not the token host).
    expect(scanHeaderInserts()[0].params[1]).toBe(PLATFORM);
    expect(scanHeaderInserts()[0].params[2]).toBe(INSTANCE_URL);

    // Analytics fired the lifecycle + a per-finding event.
    expect(startedEvent()).toBeDefined();
    expect(completedEvent()?.meta).toMatchObject({
      platform: PLATFORM,
      finding_count: findings.length,
      critical_count: 1,
    });
    expect(findingEvents()).toHaveLength(findings.length);

    // Audit recorded the scan run as a security-relevant event (hash-chained).
    const auditEntry = auditCalls.find((e) => e.action === "platform.scan_run");
    expect(auditEntry).toBeDefined();
    expect(auditEntry).toMatchObject({
      resourceType: "platform_scan",
      resourceId: "scan-1",
      afterState: { platform: PLATFORM, finding_count: findings.length, critical_count: 1 },
    });

    // Brain learning ran once per finding (no data lost).
    expect(ingestCalls).toHaveLength(findings.length);
  });
});
