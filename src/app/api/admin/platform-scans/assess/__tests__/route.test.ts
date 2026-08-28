/**
 * Contract for the client assessment endpoint.
 *
 * The assertions that matter are about the shape of a refusal. An unverified
 * target is not a failed request: the assessment ran and answered "I will not
 * scan this", which the caller has to read and show a client. Returning 403
 * would make it look like the operator lacked permission, which is a different
 * problem with a different fix.
 */
const mockRequire = jest.fn();
const mockAssess = jest.fn();
const mockAudit = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequire(...a),
}));
jest.mock("@/lib/platform-scan/engage/client-assessment", () => ({
  runClientAssessment: (...a: unknown[]) => mockAssess(...a),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));

import { POST } from "@/app/api/admin/platform-scans/assess/route";

const req = (body: unknown) =>
  ({
    json: async () => body,
    url: "https://wolfpack-instinct.vercel.app/api/admin/platform-scans/assess",
    headers: new Headers(),
  }) as never;

const ok = {
  platform: "ford-portal",
  baseUrl: "https://portal.example.com",
  routesDiscovered: 12,
  discoveredVia: "sitemap",
  findingCount: 3,
  criticalCount: 1,
  notAssessed: ["Anything behind a login."],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequire.mockResolvedValue({
    ok: true,
    user: { id: "u1", role: "cto", workspaceId: "ws1" },
    capabilities: new Set(["settings.manage_team"]),
  });
  mockAssess.mockResolvedValue(ok);
});

describe("authorization", () => {
  it("is gated on the platform-scan admin capability", async () => {
    await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    expect(mockRequire).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  it("scans nothing when the guard refuses", async () => {
    mockRequire.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req({ platform: "p", base_url: "https://x.example.com" }))).status).toBe(403);
    expect(mockAssess).not.toHaveBeenCalled();
  });
});

describe("input", () => {
  it.each<[string, Record<string, unknown>]>([
    ["both missing", {}],
    ["no address", { platform: "p" }],
    ["no platform", { base_url: "https://x.example.com" }],
  ])("rejects %s", async (_label, body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(mockAssess).not.toHaveBeenCalled();
  });

  /* A malformed address should fail with a sentence somebody can act on,
     rather than deep inside the fetcher. */
  it.each(["not-a-url", "ftp://files.example.com", "javascript:alert(1)"])(
    "rejects %s as an address",
    async (base_url) => {
      expect((await POST(req({ platform: "p", base_url }))).status).toBe(400);
      expect(mockAssess).not.toHaveBeenCalled();
    },
  );

  it("takes the workspace from the session, never the body", async () => {
    await POST(req({ platform: "p", base_url: "https://x.example.com", workspaceId: "attacker" }));
    expect(mockAssess).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", actor: { userId: "u1", role: "cto" } }),
    );
  });
});

describe("the result", () => {
  it("returns the assessment", async () => {
    const res = await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ assessment: { routesDiscovered: 12 } });
  });

  /* A refusal is an answer, not an error. The caller has to show it. */
  it("returns a refusal as a served result, not an error status", async () => {
    mockAssess.mockResolvedValue({
      ...ok,
      refused: "ownership of this target has not been verified, so nothing was scanned",
      routesDiscovered: 0,
      findingCount: 0,
    });
    const res = await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      assessment: { refused: expect.stringMatching(/ownership/i) },
    });
  });

  it("carries the boundary of the run back to the caller", async () => {
    const res = await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    const body = (await res.json()) as { assessment: { notAssessed: string[] } };
    expect(body.assessment.notAssessed.length).toBeGreaterThan(0);
  });
});

describe("the record", () => {
  /* "Who pointed us at that host, and when" is the first question asked if a
     client ever queries traffic they did not expect. */
  it("audits the run", async () => {
    await POST(req({ platform: "ford-portal", base_url: "https://portal.example.com" }));
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.client_assessment_run" }),
    );
  });

  /* A refusal is evidence the floor held, and worth the same record. */
  it("audits a refusal too", async () => {
    mockAssess.mockResolvedValue({ ...ok, refused: "ownership not verified" });
    await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    const entry = mockAudit.mock.calls[0][0] as { afterState: { refused: string | null } };
    expect(entry.afterState.refused).toBe("ownership not verified");
  });

  it("does not lose the assessment when the audit write fails", async () => {
    mockAudit.mockRejectedValueOnce(new Error("audit down"));
    expect((await POST(req({ platform: "p", base_url: "https://x.example.com" }))).status).toBe(200);
  });
});


/**
 * Credentials a client granted.
 *
 * Optional on purpose: a first pass usually runs anonymously, and requiring
 * credentials up front means asking to be trusted with them before there is
 * any reason to be.
 */
describe("granted access", () => {
  const access = {
    login_path: "/login",
    username: "svc@example.com",
    password: "hunter2",
    session_cookie_name: "sid",
  };

  it("passes credentials through for the signed-in pass", async () => {
    await POST(req({ platform: "p", base_url: "https://x.example.com", access }));
    expect(mockAssess).toHaveBeenCalledWith(
      expect.objectContaining({
        access: {
          loginPath: "/login",
          username: "svc@example.com",
          password: "hunter2",
          sessionCookieName: "sid",
        },
      }),
    );
  });

  it("runs anonymously when none were given", async () => {
    await POST(req({ platform: "p", base_url: "https://x.example.com" }));
    expect(mockAssess.mock.calls[0][0].access).toBeUndefined();
  });

  /* A half-filled credential block is a mistake, not an instruction. Treating
     it as one would produce a login attempt with an empty password. */
  it.each<[string, Record<string, unknown>]>([
    ["no password", { login_path: "/login", username: "u" }],
    ["no username", { login_path: "/login", password: "p" }],
    ["no path", { username: "u", password: "p" }],
  ])("ignores an incomplete grant: %s", async (_label, partial) => {
    await POST(req({ platform: "p", base_url: "https://x.example.com", access: partial }));
    expect(mockAssess.mock.calls[0][0].access).toBeUndefined();
  });

  /* THE ONE THAT MATTERS. An audit log holding a client's password is a
     permanent copy of their secret in the one table designed never to be
     edited. That a signed-in scan happened is the auditable fact. */
  it("never writes the password to the audit log", async () => {
    mockAssess.mockResolvedValue({ ...ok, authenticated: true, internalSurfaces: 6 });
    await POST(req({ platform: "p", base_url: "https://x.example.com", access }));

    const written = JSON.stringify(mockAudit.mock.calls[0][0]);
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("svc@example.com");
    /* It does record that the run was authenticated, which is the fact worth
       keeping. */
    expect(written).toContain("authenticated");
  });
});
