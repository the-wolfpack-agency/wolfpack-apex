/* eslint-disable @typescript-eslint/no-explicit-any */
const mockCreate = jest.fn();
const mockPatch = jest.fn();
const mockRetire = jest.fn();
const mockTrack = jest.fn();
let authUser: { id: string; role: string; name?: string } | null = {
  id: "u-cto",
  role: "cto",
  name: "Nick",
};

jest.mock("@/lib/principles/store", () => ({
  createPrincipleNative: (...a: any[]) => mockCreate(...a),
  patchPrincipleNative: (...a: any[]) => mockPatch(...a),
  retirePrincipleNative: (...a: any[]) => mockRetire(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { POST as postCreate } from "../route";
import { PATCH as patchOne } from "../[id]/route";
import { POST as postRetire } from "../[id]/retire/route";

beforeEach(() => {
  mockCreate.mockReset();
  mockPatch.mockReset();
  mockRetire.mockReset();
  mockTrack.mockReset();
  authUser = { id: "u-cto", role: "cto", name: "Nick" };
});

const post = (path: string, body: unknown) =>
  new NextRequest(`https://wp.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer x",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown) =>
  new NextRequest(`https://wp.test${path}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer x",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("POST /api/principles (create)", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await postCreate(post("/api/principles", { title: "X" }));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("403 for non-leadership", async () => {
    authUser = { id: "u-sales", role: "sales" };
    const res = await postCreate(post("/api/principles", { title: "X" }));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("400 when title missing", async () => {
    const res = await postCreate(post("/api/principles", { domains: [] }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("201 + analytics event on success", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "p1",
      slug: "ship-fast",
      title: "Ship fast",
    });
    const res = await postCreate(
      post("/api/principles", {
        title: "Ship fast",
        domains: ["code"],
        owner: "Hoxsie",
        bodyMd: "body",
        scoreboardWeight: 2,
        signals: ["a"],
        counterSignals: [],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.principle.id).toBe("p1");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ship fast",
        domains: ["code"],
        owner: "Hoxsie",
        signals: ["a"],
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.created",
      "u-cto",
      "cto",
      expect.objectContaining({ principle_id: "p1", slug: "ship-fast" }),
    );
  });

  test("409 on duplicate-slug error from store", async () => {
    mockCreate.mockRejectedValueOnce(
      new Error('principle with slug "x" already exists'),
    );
    const res = await postCreate(post("/api/principles", { title: "X" }));
    expect(res.status).toBe(409);
  });

  test("400 on other store error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("bad input"));
    const res = await postCreate(post("/api/principles", { title: "X" }));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/principles/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "p1" }) };

  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await patchOne(patch("/api/principles/p1", { title: "X" }), ctx);
    expect(res.status).toBe(401);
  });

  test("403 for non-leadership", async () => {
    authUser = { id: "u-sales", role: "sales" };
    const res = await patchOne(patch("/api/principles/p1", { title: "X" }), ctx);
    expect(res.status).toBe(403);
  });

  test("200 + tracks updated event with slug", async () => {
    mockPatch.mockResolvedValueOnce({
      id: "p1",
      slug: "ship-fast",
      title: "Ship faster",
    });
    const res = await patchOne(
      patch("/api/principles/p1", {
        title: "Ship faster",
        signals: ["new signal"],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principle.id).toBe("p1");
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p1",
        title: "Ship faster",
        signals: ["new signal"],
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.updated",
      "u-cto",
      "cto",
      expect.objectContaining({ principle_id: "p1", slug: "ship-fast" }),
    );
  });

  test("400 when store throws", async () => {
    mockPatch.mockRejectedValueOnce(new Error("not found"));
    const res = await patchOne(patch("/api/principles/p1", { title: "X" }), ctx);
    expect(res.status).toBe(400);
  });

  test("400 on invalid JSON", async () => {
    const req = new NextRequest("https://wp.test/api/principles/p1", {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "not json",
    });
    const res = await patchOne(req, ctx);
    expect(res.status).toBe(400);
  });

  test("owner: null is preserved (vs undefined)", async () => {
    mockPatch.mockResolvedValueOnce({ id: "p1", slug: "s", title: "T" });
    await patchOne(patch("/api/principles/p1", { owner: null }), ctx);
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", owner: null }),
    );
  });
});

describe("POST /api/principles/[id]/retire", () => {
  const ctx = { params: Promise.resolve({ id: "p1" }) };

  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await postRetire(post("/api/principles/p1/retire", {}), ctx);
    expect(res.status).toBe(401);
  });

  test("403 for non-leadership", async () => {
    authUser = { id: "u-sales", role: "sales" };
    const res = await postRetire(post("/api/principles/p1/retire", {}), ctx);
    expect(res.status).toBe(403);
  });

  test("200 + analytics event on success", async () => {
    mockRetire.mockResolvedValueOnce(undefined);
    const res = await postRetire(post("/api/principles/p1/retire", {}), ctx);
    expect(res.status).toBe(200);
    expect(mockRetire).toHaveBeenCalledWith("p1");
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.retired",
      "u-cto",
      "cto",
      expect.objectContaining({ principle_id: "p1" }),
    );
  });
});
