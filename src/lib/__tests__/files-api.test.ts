/**
 * /api/files + /api/files/[id] + /api/files/upload + /api/files/upload-session
 * + /api/files/[id]/download-url + /api/files/[id]/share route tests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetUserFiles = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserFiles(...a),
}));

const mockList = jest.fn();
const mockListCached = jest.fn();
const mockGetItem = jest.fn();
const mockUpload = jest.fn();
const mockSession = jest.fn();
const mockDownloadUrl = jest.fn();
const mockShare = jest.fn();
const mockDelete = jest.fn();

class FakeGraphFilesErr extends Error {
  status: number; retryAfter?: number;
  constructor(status: number, msg: string, ra?: number) { super(msg); this.name = "GraphFilesError"; this.status = status; this.retryAfter = ra; }
}

jest.mock("@/lib/integrations/microsoft-files", () => ({
  listDriveItems: (...a: unknown[]) => mockList(...a),
  listCachedFiles: (...a: unknown[]) => mockListCached(...a),
  getItem: (...a: unknown[]) => mockGetItem(...a),
  uploadSmallFile: (...a: unknown[]) => mockUpload(...a),
  startUploadSession: (...a: unknown[]) => mockSession(...a),
  getDownloadUrl: (...a: unknown[]) => mockDownloadUrl(...a),
  createShareLink: (...a: unknown[]) => mockShare(...a),
  deleteItem: (...a: unknown[]) => mockDelete(...a),
  SMALL_UPLOAD_MAX_BYTES: 4 * 1024 * 1024,
  GraphFilesError: FakeGraphFilesErr,
}));

import { GET as filesGET } from "@/app/api/files/route";
import { GET as fileGET, DELETE as fileDELETE } from "@/app/api/files/[id]/route";
import { POST as uploadPOST } from "@/app/api/files/upload/route";
import { POST as sessionPOST } from "@/app/api/files/upload-session/route";
import { GET as downloadGET } from "@/app/api/files/[id]/download-url/route";
import { POST as sharePOST } from "@/app/api/files/[id]/share/route";

function mkReq(opts: { auth?: string; url?: string; method?: string; body?: unknown; headers?: Record<string, string>; form?: FormData } = {}): any {
  const headers = new Headers(opts.headers ?? {});
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined && !opts.form) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/files", {
    method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
    headers,
    body: opts.form ? (opts.form as any) : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  }) as any;
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// GET /api/files
// ---------------------------------------------------------------------------

describe("GET /api/files", () => {
  it("401 without auth", async () => {
    mockGetUserFiles.mockReturnValue(null);
    const res = await filesGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns items + nextCursor from Graph", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockList.mockResolvedValue({ items: [{ name: "a" }], nextCursor: "next-url" });
    const res = await filesGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.nextCursor).toBe("next-url");
  });

  it("returns 403 + scope when scope missing", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockList.mockResolvedValue({ items: [], nextCursor: null, scopeMissing: "Files.ReadWrite" });
    const res = await filesGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.scope).toBe("Files.ReadWrite");
  });

  it("cache path reads mirror only", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockListCached.mockResolvedValue([{ name: "c" }]);
    const res = await filesGET(mkReq({ auth: "Bearer x", url: "http://test/api/files?fromCache=true" }));
    expect(mockList).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fromCache).toBe(true);
  });

  it("429 with Retry-After bubbles", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockList.mockRejectedValue(new FakeGraphFilesErr(429, "rate", 20));
    const res = await filesGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("20");
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/[id]
// ---------------------------------------------------------------------------

describe("GET /api/files/[id]", () => {
  it("404 when not found", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockGetItem.mockResolvedValue(null);
    const res = await fileGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(404);
  });

  it("200 on hit", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockGetItem.mockResolvedValue({ name: "ok" });
    const res = await fileGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/files/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/files/[id]", () => {
  it("200 on success", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockDelete.mockResolvedValue(undefined);
    const res = await fileDELETE(mkReq({ auth: "Bearer x", method: "DELETE" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("403 when scope missing", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockDelete.mockRejectedValue(new FakeGraphFilesErr(403, "no"));
    const res = await fileDELETE(mkReq({ auth: "Bearer x", method: "DELETE" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/files/upload
// ---------------------------------------------------------------------------

describe("POST /api/files/upload", () => {
  it("400 when file missing", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    const form = new FormData();
    const res = await uploadPOST(mkReq({ auth: "Bearer x", form, method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("201 on upload success", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockUpload.mockResolvedValue({ id: "loc-1", msDriveItemId: "ms-1", webUrl: "u" });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "hi.txt", { type: "text/plain" }));
    form.append("parentId", "root");
    const res = await uploadPOST(mkReq({ auth: "Bearer x", form, method: "POST" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.file.msDriveItemId).toBe("ms-1");
  });

  it("400 when filename has path separator", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    const form = new FormData();
    form.append("file", new File(["x"], "hi.txt", { type: "text/plain" }));
    form.append("filename", "a/b.txt");
    const res = await uploadPOST(mkReq({ auth: "Bearer x", form, method: "POST" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/files/upload-session
// ---------------------------------------------------------------------------

describe("POST /api/files/upload-session", () => {
  it("201 returns uploadUrl", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockSession.mockResolvedValue({ uploadUrl: "https://upload/x", expirationDateTime: "2026-05-01T00:00:00Z" });
    const res = await sessionPOST(mkReq({ auth: "Bearer x", body: { parentId: "root", filename: "a.bin" } }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.uploadUrl).toBe("https://upload/x");
  });

  it("400 when filename missing", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    const res = await sessionPOST(mkReq({ auth: "Bearer x", body: { parentId: "root" } }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/[id]/download-url
// ---------------------------------------------------------------------------

describe("GET /api/files/[id]/download-url", () => {
  it("returns url", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockDownloadUrl.mockResolvedValue("https://dl/x");
    const res = await downloadGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe("https://dl/x");
  });

  it("404 on null", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockDownloadUrl.mockResolvedValue(null);
    const res = await downloadGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "it" }) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/files/[id]/share
// ---------------------------------------------------------------------------

describe("POST /api/files/[id]/share", () => {
  it("201 on success", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    mockShare.mockResolvedValue({ url: "https://s/x", expiresAt: null, type: "view", scope: "anonymous" });
    const res = await sharePOST(
      mkReq({ auth: "Bearer x", body: { type: "view", scope: "anonymous" } }),
      { params: Promise.resolve({ id: "it" }) },
    );
    expect(res.status).toBe(201);
  });

  it("400 on invalid type", async () => {
    mockGetUserFiles.mockReturnValue({ id: "u", role: "cto" });
    const res = await sharePOST(
      mkReq({ auth: "Bearer x", body: { type: "bogus", scope: "anonymous" } }),
      { params: Promise.resolve({ id: "it" }) },
    );
    expect(res.status).toBe(400);
  });
});
