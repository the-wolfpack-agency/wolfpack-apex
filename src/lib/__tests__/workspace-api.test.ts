/**
 * workspace-api.test.ts
 *
 * Covers:
 *   PUT /api/workspace — auth, validation, shadow mode, happy path, team upsert
 *   GET /api/workspace/status — nextStep derivation for all 4 states
 */

 

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
}));

// crypto.randomUUID is available in Node 14.17+; jest test env may need it mocked
jest.mock("crypto", () => ({
  randomUUID: () => "00000000-0000-0000-0000-000000000001",
}));

import { getUserFromRequest } from "@/lib/auth";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/workspace/route";
import { GET } from "@/app/api/workspace/status/route";

const mockGetUser = getUserFromRequest as jest.MockedFunction<typeof getUserFromRequest>;

const DEMO_USER = {
  id: "u_001",
  email: "cto@wolfpack.dev",
  name: "Demo CTO",
  role: "cto" as const,
  created_at: "",
};

function makePutRequest(body?: unknown, auth?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers["authorization"] = auth;
  return new NextRequest("http://localhost/api/workspace", {
    method: "PUT",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGetRequest(auth?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (auth) headers["authorization"] = auth;
  return new NextRequest("http://localhost/api/workspace/status", {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

/* ─────────────────── PUT /api/workspace ─────────────────── */

describe("PUT /api/workspace", () => {
  test("401 when no Authorization header", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await PUT(makePutRequest({ name: "Acme" }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  test("400 when name is missing", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    const res = await PUT(makePutRequest({}, "Bearer token"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/i);
  });

  test("400 when name is empty string", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    const res = await PUT(makePutRequest({ name: "" }, "Bearer token"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/i);
  });

  test("400 when name is whitespace only", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    const res = await PUT(makePutRequest({ name: "   " }, "Bearer token"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/i);
  });

  test("400 when name exceeds 120 characters", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    const longName = "a".repeat(121);
    const res = await PUT(makePutRequest({ name: longName }, "Bearer token"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/120/);
  });

  test("503 in shadow mode (fromCache: true)", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    const res = await PUT(makePutRequest({ name: "Acme Corp" }, "Bearer token"));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("database_unavailable");
  });

  test("200 + returns trimmed name on happy path", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const res = await PUT(makePutRequest({ name: "  Acme Corp  " }, "Bearer token"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.name).toBe("Acme Corp");
  });

  test("reads prior name, upserts workspace, then team member (three safeQuery calls)", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    await PUT(makePutRequest({ name: "Wolfpack" }, "Bearer token"));
    expect(mockSafeQuery).toHaveBeenCalledTimes(3);
    // First call: SELECT prior workspace name for audit before/after diff
    const [psql] = mockSafeQuery.mock.calls[0] as [string, string[]];
    expect(psql).toMatch(/SELECT\s+name\s+FROM\s+instinct_workspace/i);
    // Second call: workspace upsert
    const [wsql, wparams] = mockSafeQuery.mock.calls[1] as [string, string[]];
    expect(wsql).toContain("instinct_workspace");
    expect(wparams).toContain("Wolfpack");
    // Third call: team member upsert
    const [tsql, tparams] = mockSafeQuery.mock.calls[2] as [string, string[]];
    expect(tsql).toContain("apex_team_members");
    expect(tparams).toContain(DEMO_USER.email);
  });

  test("accepts name of exactly 120 characters", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const maxName = "a".repeat(120);
    const res = await PUT(makePutRequest({ name: maxName }, "Bearer token"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe(maxName);
  });
});

/* ─────────────────── GET /api/workspace/status — nextStep ─────────────────── */

describe("GET /api/workspace/status nextStep derivation", () => {
  test("nextStep=profile when nothing is done (default workspace name, 0 members)", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ name: "My Workspace", setup_complete: false }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], fromCache: false });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("profile");
    expect(data.steps.profile).toBe(false);
  });

  test("nextStep=team when profile is complete but team has only 1 member", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ name: "Wolfpack", setup_complete: false }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], fromCache: false });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("team");
    expect(data.steps.profile).toBe(true);
    expect(data.steps.team).toBe(false);
  });

  test("nextStep=integrations when profile+team complete but no integrations", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ name: "Wolfpack", setup_complete: false }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 3 }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], fromCache: false });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("integrations");
    expect(data.steps.profile).toBe(true);
    expect(data.steps.team).toBe(true);
    expect(data.steps.integrations).toBe(false);
  });

  test("nextStep=complete when all steps are done", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ name: "Wolfpack", setup_complete: false }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 3 }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], fromCache: false });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("complete");
    expect(data.complete).toBe(true);
  });

  test("nextStep=complete when setup_complete flag is set (short-circuit path)", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ name: "Wolfpack", setup_complete: true }],
      fromCache: false,
    });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("complete");
    expect(data.complete).toBe(true);
    expect(data.steps.profile).toBe(true);
    expect(data.steps.team).toBe(true);
    expect(data.steps.integrations).toBe(true);
  });

  test("nextStep=profile in shadow mode", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data.nextStep).toBe("profile");
    expect(data.complete).toBe(false);
  });

  test("existing fields (complete + steps) are preserved alongside nextStep", async () => {
    mockGetUser.mockReturnValue(DEMO_USER);
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ name: "Wolfpack", setup_complete: false }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 3 }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], fromCache: false });

    const res = await GET(makeGetRequest("Bearer token"));
    const data = await res.json();
    expect(data).toHaveProperty("complete");
    expect(data).toHaveProperty("steps");
    expect(data.steps).toHaveProperty("profile");
    expect(data.steps).toHaveProperty("team");
    expect(data.steps).toHaveProperty("integrations");
    expect(data).toHaveProperty("nextStep");
  });
});

/* ─────────────── Round-trip integration tests ───────────────
 *
 * These hit BOTH PUT /api/workspace AND GET /api/workspace/status
 * with a stateful mock DB so the second call sees what the first wrote.
 *
 * Regression: the "Continue" button silently did nothing because the
 * status route had a hack that treated name === "My Workspace" as
 * no-name-set, matching the client's default placeholder. User clicks
 * Continue, PUT saves "My Workspace", status still reports
 * profile=false, step doesn't advance. Any valid non-empty name must
 * now flip profile=true.
 */
describe("PUT /api/workspace → GET /api/workspace/status round-trip", () => {
  interface MockDB {
    workspaceName: string | null;
    setupComplete: boolean;
    teamCount: number;
    integrationsCount: number;
  }

  function installStatefulMock(db: MockDB) {
    mockSafeQuery.mockImplementation(async (sql: string) => {
      const s = sql.toLowerCase();
      if (s.includes("insert") && s.includes("instinct_workspace")) {
        db.workspaceName = "CAPTURED"; // actual value comes from PUT handler logic
        return { rows: [], fromCache: false };
      }
      if (s.includes("insert") && s.includes("apex_team_members")) {
        db.teamCount = Math.max(db.teamCount, 1);
        return { rows: [], fromCache: false };
      }
      if (s.includes("from instinct_workspace")) {
        return {
          rows: db.workspaceName
            ? [{ name: db.workspaceName, setup_complete: db.setupComplete }]
            : [],
          fromCache: false,
        };
      }
      if (s.includes("from apex_team_members")) {
        return { rows: [{ count: db.teamCount }], fromCache: false };
      }
      if (s.includes("apex_integrations")) {
        return { rows: [{ count: db.integrationsCount }], fromCache: false };
      }
      return { rows: [], fromCache: false };
    });
  }

  test("user types a real workspace name → status flips profile=true → step advances to team", async () => {
    const db: MockDB = {
      workspaceName: null,
      setupComplete: false,
      teamCount: 0,
      integrationsCount: 0,
    };
    mockGetUser.mockReturnValue(DEMO_USER);
    installStatefulMock(db);

    // Pre-save: status says profile not complete, nextStep = "profile"
    const before = await (await GET(makeGetRequest("Bearer token"))).json();
    expect(before.nextStep).toBe("profile");
    expect(before.steps.profile).toBe(false);

    // Save a real name via the PUT handler
    const put = await PUT(makePutRequest({ name: "Acme Motors" }, "Bearer token"));
    expect(put.status).toBe(200);
    // Simulate what the handler wrote — the handler itself is mocked at the DB layer,
    // but the PUT route body has run. Propagate the name into our mock state.
    db.workspaceName = "Acme Motors";

    // Post-save: status must now flip profile=true AND nextStep must advance
    const after = await (await GET(makeGetRequest("Bearer token"))).json();
    expect(after.steps.profile).toBe(true);
    expect(after.nextStep).not.toBe("profile"); // critical: wizard MUST advance
    expect(after.nextStep).toBe("team");
  });

  test("workspace name 'My Workspace' is ACCEPTED as a valid name (regression guard)", async () => {
    // The previous bug: status route had `name !== "My Workspace"` which
    // treated this literal string as unset. Any non-empty trimmed name
    // must now count as a real name — a user may legitimately choose it.
    const db: MockDB = {
      workspaceName: "My Workspace",
      setupComplete: false,
      teamCount: 1,
      integrationsCount: 0,
    };
    mockGetUser.mockReturnValue(DEMO_USER);
    installStatefulMock(db);

    const res = await (await GET(makeGetRequest("Bearer token"))).json();
    expect(res.steps.profile).toBe(true);
    expect(res.nextStep).toBe("team");
  });

  test("whitespace-only name in DB is treated as not set", async () => {
    const db: MockDB = {
      workspaceName: "   ",
      setupComplete: false,
      teamCount: 1,
      integrationsCount: 0,
    };
    mockGetUser.mockReturnValue(DEMO_USER);
    installStatefulMock(db);

    const res = await (await GET(makeGetRequest("Bearer token"))).json();
    expect(res.steps.profile).toBe(false);
    expect(res.nextStep).toBe("profile");
  });
});

export {};
