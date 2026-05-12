 
const mockListSignatures = jest.fn();
const mockCreateSignature = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/email-signatures", () => {
  const actual = jest.requireActual("@/lib/email-signatures");
  return {
    ...actual,
    listSignatures: (...a: any[]) => mockListSignatures(...a),
    createSignature: (...a: any[]) => mockCreateSignature(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

beforeEach(() => {
  mockListSignatures.mockReset();
  mockCreateSignature.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleSignature = {
  id: "sig-1",
  userId: "u1",
  label: "Default",
  body: "Nick — CTO",
  isDefault: true,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

function postBody(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/email-signatures", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/email-signatures", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const req = new NextRequest("https://x.test/api/email-signatures", {
      headers: { authorization: "" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  test("returns signatures from listSignatures, scoped to caller", async () => {
    mockListSignatures.mockResolvedValueOnce([sampleSignature]);
    const req = new NextRequest("https://x.test/api/email-signatures", {
      headers: { authorization: "Bearer x" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signatures).toHaveLength(1);
    expect(body.signatures[0].id).toBe("sig-1");
    expect(mockListSignatures).toHaveBeenCalledWith("u1");
  });
});

describe("POST /api/email-signatures", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postBody({ label: "x", body: "y" }));
    expect(res.status).toBe(401);
  });

  test("400 when label missing", async () => {
    const res = await POST(postBody({ body: "y" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/label is required/);
  });

  test("400 when body missing", async () => {
    const res = await POST(postBody({ label: "x" }));
    expect(res.status).toBe(400);
  });

  test("400 on invalid JSON", async () => {
    const req = new NextRequest("https://x.test/api/email-signatures", {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("201 happy path returns signature + tracks event", async () => {
    mockCreateSignature.mockResolvedValueOnce(sampleSignature);
    const res = await POST(
      postBody({ label: "Default", body: "Nick — CTO", isDefault: true }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signature.id).toBe("sig-1");

    expect(mockCreateSignature).toHaveBeenCalledWith({
      userId: "u1",
      label: "Default",
      body: "Nick — CTO",
      isDefault: true,
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.signature_created",
      "u1",
      "ceo",
      expect.objectContaining({
        signature_id: "sig-1",
        is_default: true,
      }),
    );
  });

  test("500 when createSignature throws", async () => {
    mockCreateSignature.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(postBody({ label: "x", body: "y" }));
    expect(res.status).toBe(500);
  });

  test("isDefault defaults to false when omitted", async () => {
    mockCreateSignature.mockResolvedValueOnce({
      ...sampleSignature,
      isDefault: false,
    });
    await POST(postBody({ label: "x", body: "y" }));
    expect(mockCreateSignature).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: false }),
    );
  });
});
