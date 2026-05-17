/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn<any, any[]>();
const mockSignToken = jest.fn<string, any[]>(() => "minted.jwt.xyz");
const mockTrack = jest.fn<void, any[]>();

jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/crypto/sign", () => ({ signToken: (...a: any[]) => mockSignToken(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));

const CTO = { id: "u1", role: "cto", name: "Nick", email: "n@x.co", workspaceId: "default" };
let user: typeof CTO | null = CTO;
jest.mock("@/lib/auth", () => ({ getUserFromRequest: () => user }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const REQ = () =>
  new NextRequest("https://x.test/api/admin/provision-health-bot", {
    method: "POST",
    headers: { authorization: "Bearer cto-jwt" },
  });

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockSignToken.mockReset();
  mockSignToken.mockReturnValue("minted.jwt.xyz");
  mockTrack.mockReset();
  user = CTO;
});

describe("POST /api/admin/provision-health-bot", () => {
  test("401 when unauthenticated", async () => {
    user = null;
    const r = await POST(REQ());
    expect(r.status).toBe(401);
  });

  test("403 when role is not CEO/CTO", async () => {
    user = { ...CTO, role: "dev" };
    const r = await POST(REQ());
    expect(r.status).toBe(403);
  });

  test("creates bot when missing, grants only admin.health.probe, returns minted JWT", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT bot
      .mockResolvedValueOnce({ rows: [] }) // INSERT bot
      .mockResolvedValueOnce({ rows: [] }); // UPDATE caps
    const r = await POST(REQ());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.token).toBe("minted.jwt.xyz");
    expect(body.botUserId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    /* Verify the capability_overrides write granted ONLY the probe cap. */
    const updateCall = mockSafeQuery.mock.calls.find((c) => c[0].includes("UPDATE"));
    const params = updateCall?.[1] as [string, string];
    const parsed = JSON.parse(params[1]);
    expect(parsed.grants).toEqual(["admin.health.probe"]);
    expect(parsed.revokes).toEqual([]);
  });

  test("re-runs are idempotent — uses existing bot row instead of inserting", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: "existing-bot-id" }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE
    const r = await POST(REQ());
    const body = await r.json();
    expect(body.botUserId).toBe("existing-bot-id");
    /* No INSERT call. */
    const inserts = mockSafeQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO instinct_team_members"),
    );
    expect(inserts).toHaveLength(0);
  });

  test("signs the JWT with bot role=dev (not the caller's CTO role)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await POST(REQ());
    const call = mockSignToken.mock.calls[0] as unknown as [{ role: string; email: string }];
    expect(call[0].role).toBe("dev");
    expect(call[0].email).toBe("agenticqa-bot@thewolfpack.agency");
  });
});
