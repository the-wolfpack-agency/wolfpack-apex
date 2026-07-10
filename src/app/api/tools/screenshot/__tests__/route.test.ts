/**
 * Contract tests for the screenshot capture route (POST /api/tools/screenshot)
 * and the serving route (GET /api/tools/screenshot/[id]). The capture engine
 * and DB are mocked, so no browser launches and no DB is touched.
 */

export {};

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));

const mockCapture = jest.fn();
jest.mock("@/lib/tools/screenshot", () => ({
  captureScreenshot: (...a: any[]) => mockCapture(...a),
}));

const mockStore = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/tools/screenshot/store", () => ({
  storeScreenshot: (...a: any[]) => mockStore(...a),
  getScreenshot: (...a: any[]) => mockGet(...a),
  MAX_SCREENSHOT_BYTES: 6_000_000,
}));

import { POST } from "@/app/api/tools/screenshot/route";
import { GET } from "@/app/api/tools/screenshot/[id]/route";

const USER = { id: "u1", role: "admin", workspaceId: "ws1" };
function okAuth() {
  return { ok: true, user: USER };
}
function denied(status: number) {
  return { ok: false, response: { status, json: async () => ({ error: "denied" }) } };
}
function mkReq(body: unknown): any {
  return { headers: new Headers(), url: "http://x/api/tools/screenshot", json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(okAuth());
  mockCapture.mockResolvedValue({ ok: true, png: Buffer.from("PNGDATA") });
  mockStore.mockResolvedValue({ id: "shot-9", byteSize: 7 });
});

describe("POST /api/tools/screenshot", () => {
  it("401 when capability denied", async () => {
    mockRequireCapability.mockResolvedValue(denied(401));
    const res = await POST(mkReq({ url: "https://x.com" }));
    expect(res.status).toBe(401);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("400 when url is missing", async () => {
    const res = await POST(mkReq({}));
    expect(res.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("201 captures, stores, and returns the imageUrl", async () => {
    const res = await POST(mkReq({ url: "  https://example.com  " }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; imageUrl: string; fullRedirectUrl: string };
    expect(body.id).toBe("shot-9");
    expect(body.imageUrl).toBe("/api/tools/screenshot/shot-9");
    expect(body.fullRedirectUrl).toBe("/api/tools/screenshot/shot-9");
    expect(mockCapture).toHaveBeenCalledWith({ url: "https://example.com", fullPage: true });
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", createdBy: "u1", sourceUrl: "https://example.com" }),
    );
  });

  it("400 on an SSRF-blocked url (no store)", async () => {
    mockCapture.mockResolvedValue({ ok: false, code: "ssrf_blocked", error: "blocked internal host" });
    const res = await POST(mkReq({ url: "http://127.0.0.1" }));
    expect(res.status).toBe(400);
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("502 when the browser engine fails", async () => {
    mockCapture.mockResolvedValue({ ok: false, code: "capture_failed", error: "protocol error" });
    const res = await POST(mkReq({ url: "https://example.com" }));
    expect(res.status).toBe(502);
  });

  it("413 when the capture exceeds the size cap", async () => {
    mockCapture.mockResolvedValue({ ok: true, png: Buffer.alloc(6_000_001) });
    const res = await POST(mkReq({ url: "https://example.com" }));
    expect(res.status).toBe(413);
    expect(mockStore).not.toHaveBeenCalled();
  });
});

describe("GET /api/tools/screenshot/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "shot-9" }) };

  it("401 when capability denied", async () => {
    mockRequireCapability.mockResolvedValue(denied(401));
    const res = await GET(mkReq(null), ctx as any);
    expect(res.status).toBe(401);
  });

  it("404 when the shot is missing / cross-tenant", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(mkReq(null), ctx as any);
    expect(res.status).toBe(404);
  });

  it("200 serves the PNG bytes with a strict CSP", async () => {
    const png = Buffer.from("PNGDATA");
    mockGet.mockResolvedValue({
      contentType: "image/png",
      dataBase64: png.toString("base64"),
      byteSize: png.length,
    });
    const res = await GET(mkReq(null), ctx as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(mockGet).toHaveBeenCalledWith("shot-9", "ws1");
  });
});
