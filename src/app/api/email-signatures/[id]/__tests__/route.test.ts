 
const mockUpdateSignature = jest.fn();
const mockDeleteSignature = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/email-signatures", () => ({
  updateSignature: (...a: any[]) => mockUpdateSignature(...a),
  deleteSignature: (...a: any[]) => mockDeleteSignature(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "../route";

beforeEach(() => {
  mockUpdateSignature.mockReset();
  mockDeleteSignature.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleSignature = {
  id: "sig-1",
  userId: "u1",
  label: "Renamed",
  body: "New body",
  isDefault: false,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

function patchReq(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/email-signatures/sig-1", {
    method: "PATCH",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("PATCH /api/email-signatures/[id]", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await PATCH(patchReq({ label: "x" }), params("sig-1"));
    expect(res.status).toBe(401);
  });

  test("400 when patch is empty", async () => {
    const res = await PATCH(patchReq({}), params("sig-1"));
    expect(res.status).toBe(400);
  });

  test("400 on invalid JSON", async () => {
    const req = new NextRequest("https://x.test/api/email-signatures/sig-1", {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "not json",
    });
    const res = await PATCH(req, params("sig-1"));
    expect(res.status).toBe(400);
  });

  test("200 happy path scopes by user.id", async () => {
    mockUpdateSignature.mockResolvedValueOnce(sampleSignature);
    const res = await PATCH(patchReq({ label: "Renamed" }), params("sig-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signature.label).toBe("Renamed");
    expect(mockUpdateSignature).toHaveBeenCalledWith(
      "sig-1",
      "u1",
      { label: "Renamed" },
    );
  });

  test("404 when row-count mismatch (wrong user)", async () => {
    mockUpdateSignature.mockRejectedValueOnce(new Error("row-count mismatch: expected 1"));
    const res = await PATCH(patchReq({ label: "x" }), params("sig-1"));
    expect(res.status).toBe(404);
  });

  test("400 when validation fails", async () => {
    mockUpdateSignature.mockRejectedValueOnce(new Error("label is required"));
    const res = await PATCH(patchReq({ label: "x" }), params("sig-1"));
    expect(res.status).toBe(400);
  });

  test("isDefault: true forwards to lib", async () => {
    mockUpdateSignature.mockResolvedValueOnce({ ...sampleSignature, isDefault: true });
    await PATCH(patchReq({ isDefault: true }), params("sig-1"));
    expect(mockUpdateSignature).toHaveBeenCalledWith(
      "sig-1",
      "u1",
      { isDefault: true },
    );
  });

  test("ignores non-string non-boolean fields silently", async () => {
    mockUpdateSignature.mockResolvedValueOnce(sampleSignature);
    await PATCH(
      patchReq({ label: "x", body: 123, isDefault: "no" }),
      params("sig-1"),
    );
    expect(mockUpdateSignature).toHaveBeenCalledWith(
      "sig-1",
      "u1",
      { label: "x" },
    );
  });
});

describe("DELETE /api/email-signatures/[id]", () => {
  function delReq(): NextRequest {
    return new NextRequest("https://x.test/api/email-signatures/sig-1", {
      method: "DELETE",
      headers: { authorization: "Bearer x" },
    });
  }

  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await DELETE(delReq(), params("sig-1"));
    expect(res.status).toBe(401);
  });

  test("200 happy path", async () => {
    mockDeleteSignature.mockResolvedValueOnce({ deleted: true });
    const res = await DELETE(delReq(), params("sig-1"));
    expect(res.status).toBe(200);
    expect(mockDeleteSignature).toHaveBeenCalledWith("sig-1", "u1");
  });

  test("404 when no row matched (wrong user)", async () => {
    mockDeleteSignature.mockResolvedValueOnce({ deleted: false });
    const res = await DELETE(delReq(), params("sig-1"));
    expect(res.status).toBe(404);
  });

  test("500 on internal error", async () => {
    mockDeleteSignature.mockRejectedValueOnce(new Error("DB down"));
    const res = await DELETE(delReq(), params("sig-1"));
    expect(res.status).toBe(500);
  });
});
