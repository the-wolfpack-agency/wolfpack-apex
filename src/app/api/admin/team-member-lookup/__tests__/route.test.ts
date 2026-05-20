/**
 * Contract tests for /api/admin/team-member-lookup.
 *
 * Locked behaviors:
 *   - 403 without settings.manage_team
 *   - 400 missing/invalid email
 *   - 200 happy path: returns member shape (no password_hash leaked,
 *     only metadata) + matching invites + silently_lost_write flag
 *   - 200 when member missing but invite is accepted: silently_lost_write=true
 *   - 503 when DB unavailable in prod mode
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

function mkReq(email: string | null): any {
  const u = email
    ? `https://app/api/admin/team-member-lookup?email=${encodeURIComponent(email)}`
    : "https://app/api/admin/team-member-lookup";
  return { url: u, headers: new Headers() };
}

const CTO = { id: "u_cto", email: "homyk@thewolfpack.agency", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("GET /api/admin/team-member-lookup", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/team-member-lookup/route");
    const res = await GET(mkReq("nickhomyk@gmail.com"));
    expect(res.status).toBe(403);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("400 missing email", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/team-member-lookup/route");
    const res = await GET(mkReq(null));
    expect(res.status).toBe(400);
  });

  it("happy path: member row + invite row, no password hash leaked, bcrypt sanity surfaced", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "tm_abc",
            email: "nickhomyk@gmail.com",
            name: "Nick",
            role: "ops",
            is_active: true,
            workspace_id: "default",
            created_at: "2026-05-20T00:00:00.000Z",
            // Real bcrypt is exactly 60 chars: "$2b$12$" + 22 salt + 31 hash.
            password_hash: "$2b$12$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU",
          },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "inv_xyz",
            email: "nickhomyk@gmail.com",
            role: "ops",
            status: "accepted",
            invited_by: "u_cto",
            workspace_id: "default",
            created_at: "2026-05-20T00:00:00.000Z",
            accepted_at: "2026-05-20T00:01:00.000Z",
            expires_at: null,
          },
        ],
        fromCache: false,
      });

    const { GET } = await import("@/app/api/admin/team-member-lookup/route");
    const res = await GET(mkReq("NickHomyk@Gmail.com"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.looked_up_as).toBe("nickhomyk@gmail.com");
    expect(body.member.exists).toBe(true);
    expect(body.member.stored_email).toBe("nickhomyk@gmail.com");
    expect(body.member.is_active).toBe(true);
    expect(body.member.password_hash.present).toBe(true);
    expect(body.member.password_hash.looks_like_bcrypt).toBe(true);
    // Critical: never leak the hash itself.
    expect(JSON.stringify(body)).not.toContain("$2b$12$abcdefghijklmnop");

    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].status).toBe("accepted");
    expect(body.invites[0].silently_lost_write).toBe(false);
  });

  it("silently_lost_write=true when invite is accepted but no team_members row exists (the bug we're diagnosing)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "inv_xyz",
            email: "nickhomyk@gmail.com",
            role: "ops",
            status: "accepted",
            invited_by: "u_cto",
            workspace_id: "default",
            created_at: "2026-05-20T00:00:00.000Z",
            accepted_at: "2026-05-20T00:01:00.000Z",
            expires_at: null,
          },
        ],
        fromCache: false,
      });

    const { GET } = await import("@/app/api/admin/team-member-lookup/route");
    const res = await GET(mkReq("nickhomyk@gmail.com"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.member.exists).toBe(false);
    expect(body.invites[0].silently_lost_write).toBe(true);
  });

  it("503 when member SELECT comes back fromCache in prod mode", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

    const { GET } = await import("@/app/api/admin/team-member-lookup/route");
    const res = await GET(mkReq("nickhomyk@gmail.com"));
    expect(res.status).toBe(503);
  });
});
