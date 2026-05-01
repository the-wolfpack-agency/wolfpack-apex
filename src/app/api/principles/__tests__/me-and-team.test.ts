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

jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListPrinciples(...a),
  listObservationsForSubject: (...a: any[]) => mockListForSubject(...a),
  listAllObservations: (...a: any[]) => mockListAll(...a),
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
    mockListForSubject.mockResolvedValueOnce([
      {
        id: "o1",
        principleId: "p1",
        surface: "mail",
        surfaceSubtype: "x",
        observedAt: "2026-05-01",
        score: -0.6,
        evidenceJsonb: { kind: "x" },
      },
    ]);
    const res = await getMe(req("/api/principles/me"));
    const body = await res.json();
    expect(body.observations).toHaveLength(1);
    expect(mockListForSubject).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ limit: 200 }),
    );
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
