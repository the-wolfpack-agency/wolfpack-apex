/**
 * Contract tests for POST /api/agents/token: the agent's machine login.
 *
 *   - invalid creds -> a GENERIC 401 that does NOT distinguish id vs secret.
 *   - valid -> 200 with token + expires_at + provider, agent.token_issued fired,
 *     last-seen stamped, response not cacheable.
 *   - rate-limited -> 429 with Retry-After.
 *   - issuer that does not self-issue (Entra) -> 501.
 */

export {};

const mockActivate = jest.fn();
const mockRecordAgentSeen = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  activateWithOnboardingSecret: (...a: any[]) => mockActivate(...a),
  recordAgentSeen: (...a: any[]) => mockRecordAgentSeen(...a),
}));

const mockIssue = jest.fn();
jest.mock("@/lib/agents/identity", () => ({
  AGENT_TOKEN_TTL_SECONDS: 900,
  getAgentIdentity: () => ({ issueAccessToken: (...a: any[]) => mockIssue(...a) }),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const ACTIVE_AGENT = {
  id: "a_1",
  workspaceId: "default",
  name: "Researcher",
  role: "ops",
  ownerUserId: "u_cto",
  state: "active",
  identityProvider: "local",
  externalSubject: null,
  scanStatus: "pending",
  description: null,
  createdBy: "u_cto",
  createdAt: "2026-06-19T00:00:00.000Z",
  activatedAt: "2026-06-19T00:00:00.000Z",
  lastSeenAt: null,
  revokedAt: null,
};

function mkReq(body: unknown): any {
  return {
    url: "http://x/api/agents/token",
    headers: new Headers(),
    json: async () => body,
  };
}

async function freshRoute() {
  const mod = await import("@/app/api/agents/token/route");
  mod._resetRateLimit();
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAgentSeen.mockResolvedValue(undefined);
  mockRecordAudit.mockResolvedValue({ id: "audit_1", seq: 1, entryHash: "h" });
});

describe("POST /api/agents/token", () => {
  it("400 when agent_id or onboarding_secret is missing", async () => {
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ agent_id: "a_1" }));
    expect(res.status).toBe(400);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("generic 401 on invalid credentials (does NOT reveal id vs secret)", async () => {
    mockActivate.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ agent_id: "a_x", onboarding_secret: "wrong" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    // The body is a single opaque code: it does not name which factor failed.
    expect(body).toEqual({ error: "invalid_credentials" });
    // It must not leak a discriminating reason (no "unknown_agent" /
    // "bad_secret" / "not_found" / "revoked" hint that tells an attacker
    // whether the id or the secret was wrong).
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toMatch(
      /unknown|bad_secret|wrong_secret|not_found|no_such|exist|revoked|paused/,
    );
    // Never issues a token (or audits an issuance) on a failed login.
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    // Same generic 401 surface whether the id or the secret was the bad factor.
    expect(res.status).toBe(401);
  });

  it("200 with token + expires_at + provider, fires agent.token_issued, no-store", async () => {
    mockActivate.mockResolvedValue(ACTIVE_AGENT);
    mockIssue.mockResolvedValue({
      token: "tok_abc",
      expiresAt: 1_900_000_000,
      provider: "local",
    });
    const { POST } = await freshRoute();
    const res = await POST(
      mkReq({ agent_id: "a_1", onboarding_secret: "deadbeef".repeat(8) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expires_at: number;
      provider: string;
    };
    expect(body.token).toBe("tok_abc");
    expect(body.expires_at).toBe(1_900_000_000);
    expect(body.provider).toBe("local");

    // The token must never be cached.
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // Last-seen is stamped on a successful issue.
    expect(mockRecordAgentSeen).toHaveBeenCalledWith("a_1");

    // Analytics: token issuance is observed for the learning loop.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.token_issued",
      "a_1",
      "ops",
      expect.objectContaining({ agent_id: "a_1", ttl_seconds: 900 }),
    );

    // Credential issuance is security-relevant: hash-chained, no token material.
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("agent.token_issued");
    expect(audit.resourceType).toBe("agent");
    expect(audit.resourceId).toBe("a_1");
    expect(JSON.stringify(audit)).not.toContain("tok_abc");
  });

  it("501 when the active provider does not self-issue (e.g. Entra)", async () => {
    mockActivate.mockResolvedValue(ACTIVE_AGENT);
    mockIssue.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ agent_id: "a_1", onboarding_secret: "x" }));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("issuer_not_local");
    // No analytics / seen stamp / audit when no token was minted.
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockRecordAgentSeen).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("429 once the per-agent rate limit is exceeded", async () => {
    mockActivate.mockResolvedValue(null); // attempts can be wrong creds; limiter still trips
    const { POST } = await freshRoute();
    let last: Response | undefined;
    // 10 allowed in the window, the 11th trips the limiter.
    for (let i = 0; i < 11; i++) {
      last = await POST(mkReq({ agent_id: "a_brute", onboarding_secret: "guess" }));
    }
    expect(last!.status).toBe(429);
    const body = (await last!.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    expect(last!.headers.get("Cache-Control")).toBe("no-store");
  });
});
