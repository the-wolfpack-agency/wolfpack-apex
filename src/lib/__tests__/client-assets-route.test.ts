/**
 * /api/clients/[id]/assets route tests.
 *
 * Pattern mirrors domain-route.test.ts — mock every server dep, import
 * the handlers directly, assemble a NextRequest, inspect the response.
 *
 * Covers the full auth / capability / validation / happy-path matrix:
 *   - GET 401 without auth, 403 without clients.view, 200 happy path.
 *   - POST 401/403 same, 400 on missing fields / bad mime / bad kind,
 *     201 happy path, dedupe (existing sha256 returns existing row
 *     with use_count > 1 and skips re-saving the blob).
 *   - DELETE 401 / 403 / 404 (cross-client) / 200 / 500 matrix.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  extractRequestMetadata: () => ({}),
}));

const mockList = jest.fn();
const mockUpload = jest.fn();
const mockSoftDelete = jest.fn();
const mockGetById = jest.fn();
const mockSaveBlob = jest.fn();
jest.mock("@/lib/client-assets", () => ({
  listAssetsForClient: (...args: unknown[]) => mockList(...args),
  recordAssetUpload: (...args: unknown[]) => mockUpload(...args),
  softDeleteAsset: (...args: unknown[]) => mockSoftDelete(...args),
  getAssetById: (...args: unknown[]) => mockGetById(...args),
  saveAssetBlob: (...args: unknown[]) => mockSaveBlob(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "@/app/api/clients/[id]/assets/route";
import { DELETE } from "@/app/api/clients/[id]/assets/[assetId]/route";

function req(
  method: string,
  url = "http://test/api/clients/acme/assets",
  body?: unknown,
) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function allowAs(role: string, userId = "u_1") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email: "u@test", name: "U", role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function denyWith(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

// Tiny 1x1 png — well under size cap, known good mime.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

describe("GET /api/clients/[id]/assets", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 without clients.view", async () => {
    denyWith(403, "forbidden");
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(403);
  });

  it("200 returns the assets list", async () => {
    allowAs("sales");
    mockList.mockResolvedValueOnce([
      { id: "a_1", clientSlug: "acme", assetKind: "logo", filename: "logo.png" },
    ]);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ id: string }> };
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0].id).toBe("a_1");
  });

  it("passes ?kind= through to the lib", async () => {
    allowAs("sales");
    mockList.mockResolvedValueOnce([]);
    await GET(req("GET", "http://test/api/clients/acme/assets?kind=logo"), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(mockList).toHaveBeenCalledWith("acme", { kind: "logo" });
  });

  it("ignores unknown kind filter (falls back to unfiltered list)", async () => {
    allowAs("sales");
    mockList.mockResolvedValueOnce([]);
    await GET(req("GET", "http://test/api/clients/acme/assets?kind=bogus"), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(mockList).toHaveBeenCalledWith("acme", undefined);
  });
});

describe("POST /api/clients/[id]/assets", () => {
  const validBody = {
    filename: "logo.png",
    content_base64: TINY_PNG_BASE64,
    mime: "image/png",
    kind: "logo",
  };

  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await POST(req("POST", undefined, validBody), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 without clients.edit", async () => {
    denyWith(403, "forbidden");
    const res = await POST(req("POST", undefined, validBody), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(403);
  });

  it("400 on missing required fields", async () => {
    allowAs("sales");
    const res = await POST(req("POST", undefined, { filename: "x.png" }), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on invalid json", async () => {
    allowAs("sales");
    const bad = new NextRequest("http://test/api/clients/acme/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(bad, { params: Promise.resolve({ id: "acme" }) });
    expect(res.status).toBe(400);
  });

  it("400 on unsupported mime", async () => {
    allowAs("sales");
    const res = await POST(
      req("POST", undefined, {
        ...validBody,
        mime: "application/x-msdownload",
      }),
      { params: Promise.resolve({ id: "acme" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid kind", async () => {
    allowAs("sales");
    const res = await POST(
      req("POST", undefined, { ...validBody, kind: "banana" }),
      { params: Promise.resolve({ id: "acme" }) },
    );
    expect(res.status).toBe(400);
  });

  it("201 happy path returns the asset with use_count 1 (fresh) and records audit", async () => {
    allowAs("sales");
    mockUpload.mockImplementationOnce(async (input: { id?: string }) => ({
      id: input.id ?? "a_new",
      clientSlug: "acme",
      assetKind: "logo",
      filename: "logo.png",
      url: `/api/clients/acme/assets/${input.id}/raw`,
      mime: "image/png",
      sizeBytes: 70,
      sha256: "deadbeef",
      altText: null,
      useCount: 1,
      lastUsedAt: null,
      uploadedAt: "2026-04-19T00:00:00Z",
    }));
    mockSaveBlob.mockResolvedValueOnce(undefined);
    const res = await POST(req("POST", undefined, validBody), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset: { useCount: number } };
    expect(body.asset.useCount).toBe(1);
    expect(mockSaveBlob).toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "client_asset.uploaded",
        resourceType: "client_asset",
      }),
    );
  });

  it("dedupe: recordAssetUpload returns a DIFFERENT id → use_count > 1, blob NOT re-saved, audit action = reused", async () => {
    allowAs("sales");
    mockUpload.mockResolvedValueOnce({
      id: "pre_existing",
      clientSlug: "acme",
      assetKind: "logo",
      filename: "logo.png",
      url: "/api/clients/acme/assets/pre_existing/raw",
      mime: "image/png",
      sizeBytes: 70,
      sha256: "dup_hash",
      altText: null,
      useCount: 2,
      lastUsedAt: "2026-04-19T00:00:00Z",
      uploadedAt: "2026-04-10T00:00:00Z",
    });
    const res = await POST(req("POST", undefined, validBody), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset: { id: string; useCount: number } };
    expect(body.asset.id).toBe("pre_existing");
    expect(body.asset.useCount).toBe(2);
    expect(mockSaveBlob).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "client_asset.reused" }),
    );
  });

  it("500 when recordAssetUpload throws", async () => {
    allowAs("sales");
    mockUpload.mockRejectedValueOnce(new Error("writeQuery row-count mismatch"));
    const res = await POST(req("POST", undefined, validBody), {
      params: Promise.resolve({ id: "acme" }),
    });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/clients/[id]/assets/[assetId]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 without clients.edit", async () => {
    denyWith(403, "forbidden");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when asset doesn't exist", async () => {
    allowAs("sales");
    mockGetById.mockResolvedValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(404);
  });

  it("404 when asset belongs to a different client (cross-tenant guard)", async () => {
    allowAs("sales");
    mockGetById.mockResolvedValueOnce({
      id: "a_1",
      clientSlug: "NOT_acme",
      assetKind: "logo",
      filename: "x.png",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "h",
      altText: null,
      useCount: 1,
      lastUsedAt: null,
      uploadedAt: "t",
    });
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(404);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("200 + calls softDeleteAsset + records audit on happy path", async () => {
    allowAs("sales");
    mockGetById.mockResolvedValueOnce({
      id: "a_1",
      clientSlug: "acme",
      assetKind: "logo",
      filename: "logo.png",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "h",
      altText: null,
      useCount: 1,
      lastUsedAt: null,
      uploadedAt: "t",
    });
    mockSoftDelete.mockResolvedValueOnce(undefined);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(200);
    expect(mockSoftDelete).toHaveBeenCalledWith("a_1", {
      userId: "u_1",
      userRole: "sales",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "client_asset.deleted",
        resourceType: "client_asset",
      }),
    );
  });

  it("500 when softDeleteAsset throws", async () => {
    allowAs("sales");
    mockGetById.mockResolvedValueOnce({
      id: "a_1",
      clientSlug: "acme",
      assetKind: "logo",
      filename: "x",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "h",
      altText: null,
      useCount: 1,
      lastUsedAt: null,
      uploadedAt: "t",
    });
    mockSoftDelete.mockRejectedValueOnce(new Error("db down"));
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "acme", assetId: "a_1" }),
    });
    expect(res.status).toBe(500);
  });
});
