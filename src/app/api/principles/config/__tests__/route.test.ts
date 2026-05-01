/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockResolve = jest.fn();
const mockTrack = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u-cto",
  role: "cto",
  name: "Nick",
  email: "n@x",
};

jest.mock("@/lib/principles/config", () => ({
  getPrinciplesConfig: (...a: any[]) => mockGet(...a),
  setPrinciplesConfig: (...a: any[]) => mockSet(...a),
  resolvePrinciplesConfig: (...a: any[]) => mockResolve(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET, PUT } from "../route";

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockResolve.mockReset();
  mockTrack.mockReset();
  authUser = { id: "u-cto", role: "cto", name: "Nick", email: "n@x" };
});

const req = (method: "GET" | "PUT", body?: unknown) =>
  new NextRequest("https://wp.test/api/principles/config", {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe("GET /api/principles/config", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    expect((await GET(req("GET"))).status).toBe(401);
  });
  test("403 non-leadership", async () => {
    authUser = { id: "u1", role: "sales", name: "x", email: "x" };
    expect((await GET(req("GET"))).status).toBe(403);
  });
  test("200 returns stored + effective", async () => {
    mockGet.mockResolvedValueOnce({
      docUrl: "x",
      ownerUserId: null,
      updatedBy: "u",
      updatedAt: "2026",
    });
    mockResolve.mockResolvedValueOnce({
      docUrl: "x",
      ownerUserId: "u-auto",
      ownerAutoDetected: true,
    });
    const body = await (await GET(req("GET"))).json();
    expect(body.docUrl).toBe("x");
    expect(body.effective.ownerAutoDetected).toBe(true);
  });
});

describe("PUT /api/principles/config", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    expect((await PUT(req("PUT", {}))).status).toBe(401);
  });
  test("403 non-leadership", async () => {
    authUser = { id: "u1", role: "sales", name: "x", email: "x" };
    expect((await PUT(req("PUT", {}))).status).toBe(403);
  });
  test("400 invalid URL", async () => {
    const res = await PUT(req("PUT", { docUrl: "not-a-url" }));
    expect(res.status).toBe(400);
  });
  test("200 saves + emits analytics", async () => {
    mockSet.mockResolvedValueOnce({
      docUrl: "https://sp/x",
      ownerUserId: null,
      updatedBy: "u-cto",
      updatedAt: "2026",
    });
    const res = await PUT(req("PUT", { docUrl: "https://sp/x" }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ docUrl: "https://sp/x", updatedBy: "u-cto" }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.config_updated",
      "u-cto",
      "cto",
      expect.objectContaining({ has_doc_url: true }),
    );
  });
});
