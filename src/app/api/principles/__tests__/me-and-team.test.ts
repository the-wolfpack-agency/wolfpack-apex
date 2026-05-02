/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListPrinciples = jest.fn();
const mockListForSubject = jest.fn();
const mockListAll = jest.fn();
const mockRecordView = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "sales",
  name: "Alicia",
  email: "a@x",
};

const mockSafeQuery = jest.fn();
jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListPrinciples(...a),
  listObservationsForSubject: (...a: any[]) => mockListForSubject(...a),
  listAllObservations: (...a: any[]) => mockListAll(...a),
  listSignalsForPrinciple: jest.fn(async () => []),
}));
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
  };
});
/* The team route still uses resolveUserNames; My-principles no
   longer does. Default mock: each id resolves to itself so existing
   team tests preserve their 1-row-per-id assumption. */
let mockResolveNamesImpl: (
  ids: string[],
) => Promise<Map<string, { userId: string; displayName: string; email: string | null }>> = async (
  ids,
) => {
  const m = new Map<string, { userId: string; displayName: string; email: string | null }>();
  for (const id of ids) {
    m.set(id, { userId: id, displayName: id, email: `${id}@x` });
  }
  return m;
};
jest.mock("@/lib/principles/user-names", () => ({
  resolveUserNames: (ids: string[]) => mockResolveNamesImpl(ids),
}));
jest.mock("@/lib/principles/authz", () => {
  const actual = jest.requireActual("@/lib/principles/authz");
  return {
    ...actual,
    recordEvidenceView: (...a: any[]) => mockRecordView(...a),
  };
});
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET as getMe } from "../me/route";
import { GET as getTeam } from "../team/route";

beforeEach(() => {
  mockListPrinciples.mockReset();
  mockListForSubject.mockReset();
  mockListAll.mockReset();
  mockRecordView.mockReset();
  mockSafeQuery.mockReset();
  /* Default canonical resolver: identity map — every id resolves to
     itself. Tests that need cross-id canonicalization override per-call. */
  mockSafeQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    const ids = (params[0] as string[]) ?? [];
    return {
      rows: ids.map((id) => ({ subject_id: id, canonical_id: id })),
    };
  });
  authUser = { id: "u1", role: "sales", name: "Alicia", email: "a@x" };
});

const req = (path: string) =>
  new NextRequest(`https://wp.test${path}`, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });

describe("GET /api/principles/me", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await getMe(req("/api/principles/me"));
    expect(res.status).toBe(401);
  });
  test("returns own observations only", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      { id: "p1", slug: "x", title: "X", domains: ["mail"], bodyMd: "" },
    ]);
    mockListAll.mockResolvedValueOnce([
      {
        id: "o1",
        principleId: "p1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u1",
        observedAt: "2026-05-01",
        score: -0.6,
        evidenceJsonb: { kind: "x" },
      },
    ]);
    /* identity canonicalize (default mock): u1 → u1 → matches authUser. */
    const res = await getMe(req("/api/principles/me"));
    const body = await res.json();
    expect(body.observations).toHaveLength(1);
  });

  test("includes observations under sibling user-ids that canonicalize to caller", async () => {
    /* Hoxsie scenario: JWT user.id = "u1" but observations were
       written under "u-old" (dedup-survivor). The DB canonicalize CTE
       maps both u1 AND u-old → same canonical id "u-canon". The route
       includes u-old's observations. u-someone-else canonicalizes
       to itself and stays excluded. */
    mockListPrinciples.mockResolvedValueOnce([
      { id: "p1", slug: "x", title: "X", domains: ["mail"], bodyMd: "" },
    ]);
    mockListAll.mockResolvedValueOnce([
      {
        id: "o-mine",
        principleId: "p1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u-old",
        observedAt: "2026-05-01",
        score: -0.6,
        evidenceJsonb: { kind: "x" },
      },
      {
        id: "o-not-mine",
        principleId: "p1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u-someone-else",
        observedAt: "2026-05-01",
        score: -0.4,
        evidenceJsonb: { kind: "x" },
      },
    ]);
    /* Canonicalize: u1 → u-canon, u-old → u-canon, u-someone-else → self. */
    mockSafeQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) => {
      const ids = (params[0] as string[]) ?? [];
      return {
        rows: ids.map((id) => ({
          subject_id: id,
          canonical_id:
            id === "u1" || id === "u-old" ? "u-canon" : id,
        })),
      };
    });
    const res = await getMe(req("/api/principles/me"));
    const body = await res.json();
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].id).toBe("o-mine");
  });
});

describe("GET /api/principles/team", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await getTeam(req("/api/principles/team"));
    expect(res.status).toBe(401);
  });
  test("403 for non-leadership members", async () => {
    authUser = { id: "u1", role: "sales", name: "Alicia", email: "a@x" };
    const res = await getTeam(req("/api/principles/team"));
    expect(res.status).toBe(403);
    expect(mockListAll).not.toHaveBeenCalled();
    expect(mockRecordView).not.toHaveBeenCalled();
  });
  test("200 for leadership + audit-log fires + aggregates compute", async () => {
    authUser = { id: "u-cto", role: "cto", name: "Nick", email: "n@x" };
    mockListPrinciples.mockResolvedValueOnce([
      {
        id: "p1",
        slug: "x",
        title: "X",
        domains: [],
        scoreboardWeight: 3,
        owner: "Hoxsie",
      },
    ]);
    mockListAll.mockResolvedValueOnce([
      {
        id: "o1",
        principleId: "p1",
        validatorId: "v1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u-a",
        observedAt: "2026-05-01",
        score: -0.6,
        evidenceJsonb: {},
      },
      {
        id: "o2",
        principleId: "p1",
        validatorId: "v1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u-a",
        observedAt: "2026-05-01",
        score: -0.4,
        evidenceJsonb: {},
      },
      {
        id: "o3",
        principleId: "p1",
        validatorId: "v1",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u-b",
        observedAt: "2026-05-01",
        score: -0.6,
        evidenceJsonb: {},
      },
    ]);
    const res = await getTeam(req("/api/principles/team"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observations).toHaveLength(3);
    /* Aggregates: 2 rows for (p1, u-a) mean -0.5; 1 row for (p1, u-b) mean -0.6. */
    const ua = body.aggregates.find(
      (a: any) => a.subjectUserId === "u-a" && a.principleId === "p1",
    );
    const ub = body.aggregates.find(
      (a: any) => a.subjectUserId === "u-b" && a.principleId === "p1",
    );
    expect(ua.count).toBe(2);
    expect(ua.meanScore).toBe(-0.5);
    expect(ub.count).toBe(1);
    expect(mockRecordView).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: { id: "u-cto", role: "cto" },
        route: "/api/principles/team",
        evidenceCount: 3,
      }),
    );
  });
});
