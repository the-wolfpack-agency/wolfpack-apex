/**
 * Microsoft Files integration tests — list/get/upload small/upload session/
 * download-url/share/delete, 403 → scope_missing, audit written.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackFiles = jest.fn();
const mockQueryFiles = jest.fn();
const mockSafeQueryFiles = jest.fn();
const mockGetValidTokenFiles = jest.fn();
const mockRecordAuditFiles = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackFiles(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryFiles(...args),
  safeQuery: (...args: any[]) => mockSafeQueryFiles(...args),
  pool: { query: jest.fn() },
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenFiles(...args),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditFiles(...args),
}));

const realFetchFiles = global.fetch;
const fetchMockFiles = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockFiles;
});
afterAll(() => {
  (global as any).fetch = realFetchFiles;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockFiles.mockReset();
  mockGetValidTokenFiles.mockResolvedValue({ accessToken: "tok", userEmail: "u@e.com" });
  mockRecordAuditFiles.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
  mockQueryFiles.mockResolvedValue({ rows: [{ id: "row-1", synced_at: new Date().toISOString() }] });
  mockSafeQueryFiles.mockResolvedValue({ rows: [] });
});

function okResponseFiles(data: unknown, headers: Record<string, string> = {}): any {
  return {
    ok: true, status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResponseFiles(status: number, text = "err", headers: Record<string, string> = {}): any {
  return {
    ok: false, status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

// ---------------------------------------------------------------------------
// listDriveItems
// ---------------------------------------------------------------------------

describe("listDriveItems", () => {
  it("hits /me/drive/root/children by default and upserts", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      value: [
        { id: "item-1", name: "a.txt", file: { mimeType: "text/plain" }, size: 10 },
      ],
    }));
    const { listDriveItems } = await import("@/lib/integrations/microsoft-files");
    const res = await listDriveItems("u-1");
    expect(res.items).toHaveLength(1);
    expect(res.items[0].msDriveItemId).toBe("item-1");
    expect(fetchMockFiles.mock.calls[0][0]).toContain("me/drive/root/children");
    expect(mockQueryFiles).toHaveBeenCalled();
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_list_fetched",
      "u-1",
      "system",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("uses parent folder endpoint when parentId is set", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({ value: [] }));
    const { listDriveItems } = await import("@/lib/integrations/microsoft-files");
    await listDriveItems("u-1", { parentId: "folder-abc" });
    expect(fetchMockFiles.mock.calls[0][0]).toContain("me/drive/items/folder-abc/children");
  });

  it("returns scopeMissing on 403", async () => {
    fetchMockFiles.mockResolvedValueOnce(errResponseFiles(403, "forbidden"));
    const { listDriveItems } = await import("@/lib/integrations/microsoft-files");
    const res = await listDriveItems("u-1");
    expect(res.scopeMissing).toBe("Files.ReadWrite");
    expect(res.items).toEqual([]);
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_operation_failed",
      "u-1",
      "system",
      expect.objectContaining({ op: "list", reason: "scope_missing" }),
    );
  });

  it("retries once on 429 honoring Retry-After", async () => {
    fetchMockFiles
      .mockResolvedValueOnce(errResponseFiles(429, "slow", { "retry-after": "0" }))
      .mockResolvedValueOnce(okResponseFiles({ value: [] }));
    const { listDriveItems } = await import("@/lib/integrations/microsoft-files");
    const res = await listDriveItems("u-1");
    expect(res.items).toEqual([]);
    expect(fetchMockFiles).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getItem
// ---------------------------------------------------------------------------

describe("getItem", () => {
  it("returns null on 404", async () => {
    fetchMockFiles.mockResolvedValueOnce(errResponseFiles(404, "gone"));
    const { getItem } = await import("@/lib/integrations/microsoft-files");
    const item = await getItem("u-1", "item-x");
    expect(item).toBeNull();
  });

  it("upserts on 200", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      id: "it-1", name: "f.txt", size: 1, file: { mimeType: "text/plain" },
    }));
    const { getItem } = await import("@/lib/integrations/microsoft-files");
    const item = await getItem("u-1", "it-1");
    expect(item?.msDriveItemId).toBe("it-1");
    expect(mockQueryFiles).toHaveBeenCalled();
  });

  it("returns null + analytics on 403", async () => {
    fetchMockFiles.mockResolvedValueOnce(errResponseFiles(403));
    const { getItem } = await import("@/lib/integrations/microsoft-files");
    const item = await getItem("u-1", "it-1");
    expect(item).toBeNull();
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_operation_failed",
      "u-1",
      "system",
      expect.objectContaining({ op: "get", reason: "scope_missing" }),
    );
  });
});

// ---------------------------------------------------------------------------
// uploadSmallFile
// ---------------------------------------------------------------------------

describe("uploadSmallFile", () => {
  it("PUTs to content endpoint, audits, emits analytics", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      id: "uploaded-1", name: "hi.txt", size: 3, webUrl: "https://x/hi", file: { mimeType: "text/plain" },
    }));
    const { uploadSmallFile } = await import("@/lib/integrations/microsoft-files");
    const out = await uploadSmallFile("u-1", "root", "hi.txt", "text/plain", Buffer.from("hi!"));
    expect(out.msDriveItemId).toBe("uploaded-1");
    expect(fetchMockFiles.mock.calls[0][0]).toContain("me/drive/root:/hi.txt:/content");
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_uploaded",
      "u-1",
      "system",
      expect.objectContaining({ item_id: "uploaded-1" }),
    );
    expect(mockRecordAuditFiles).toHaveBeenCalledWith(
      expect.objectContaining({ action: "files.uploaded", resourceId: "uploaded-1" }),
    );
  });

  it("rejects buffer over 4 MB", async () => {
    const { uploadSmallFile, GraphFilesError } = await import("@/lib/integrations/microsoft-files");
    const huge = Buffer.alloc(4 * 1024 * 1024 + 1);
    await expect(uploadSmallFile("u-1", "root", "x", "app/oct", huge)).rejects.toBeInstanceOf(GraphFilesError);
  });

  it("rejects filenames with path separators", async () => {
    const { uploadSmallFile, GraphFilesError } = await import("@/lib/integrations/microsoft-files");
    await expect(
      uploadSmallFile("u-1", "root", "bad/name.txt", "text/plain", Buffer.from("x")),
    ).rejects.toBeInstanceOf(GraphFilesError);
  });

  it("on 403 emits failed analytics and rethrows", async () => {
    fetchMockFiles.mockResolvedValueOnce(errResponseFiles(403));
    const { uploadSmallFile } = await import("@/lib/integrations/microsoft-files");
    await expect(uploadSmallFile("u-1", "root", "x.txt", "text/plain", Buffer.from("x"))).rejects.toMatchObject({ status: 403 });
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_operation_failed",
      "u-1",
      "system",
      expect.objectContaining({ op: "upload_small", reason: "scope_missing" }),
    );
  });
});

// ---------------------------------------------------------------------------
// startUploadSession
// ---------------------------------------------------------------------------

describe("startUploadSession", () => {
  it("returns uploadUrl + expirationDateTime", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      uploadUrl: "https://upload.example/session",
      expirationDateTime: "2026-04-16T00:00:00Z",
    }));
    const { startUploadSession } = await import("@/lib/integrations/microsoft-files");
    const s = await startUploadSession("u-1", "root", "big.zip");
    expect(s.uploadUrl).toMatch(/session/);
    expect(fetchMockFiles.mock.calls[0][0]).toContain(":/big.zip:/createUploadSession");
  });
});

// ---------------------------------------------------------------------------
// getDownloadUrl
// ---------------------------------------------------------------------------

describe("getDownloadUrl", () => {
  it("returns URL + analytics on success", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      id: "it-1", name: "f.txt", "@microsoft.graph.downloadUrl": "https://dl.example/x",
    }));
    const { getDownloadUrl } = await import("@/lib/integrations/microsoft-files");
    const url = await getDownloadUrl("u-1", "it-1");
    expect(url).toBe("https://dl.example/x");
    expect(mockTrackFiles).toHaveBeenCalledWith(
      "system.ms_file_downloaded",
      "u-1",
      "system",
      expect.objectContaining({ item_id: "it-1" }),
    );
  });

  it("returns null on 403", async () => {
    fetchMockFiles.mockResolvedValueOnce(errResponseFiles(403));
    const { getDownloadUrl } = await import("@/lib/integrations/microsoft-files");
    expect(await getDownloadUrl("u-1", "it-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createShareLink
// ---------------------------------------------------------------------------

describe("createShareLink", () => {
  it("returns link + writes audit", async () => {
    fetchMockFiles.mockResolvedValueOnce(okResponseFiles({
      link: { webUrl: "https://share.example/l" },
      expirationDateTime: "2026-05-01T00:00:00Z",
    }));
    const { createShareLink } = await import("@/lib/integrations/microsoft-files");
    const share = await createShareLink("u-1", "it-1", { type: "view", scope: "organization" });
    expect(share.url).toBe("https://share.example/l");
    expect(share.scope).toBe("organization");
    expect(mockRecordAuditFiles).toHaveBeenCalledWith(
      expect.objectContaining({ action: "files.share_created" }),
    );
  });
});

// ---------------------------------------------------------------------------
// deleteItem
// ---------------------------------------------------------------------------

describe("deleteItem", () => {
  it("sends DELETE, purges cache, audits", async () => {
    mockSafeQueryFiles.mockResolvedValueOnce({ rows: [{ name: "f.txt", size_bytes: 1, web_url: "u" }] });
    fetchMockFiles.mockResolvedValueOnce({ ok: true, status: 204, headers: { get: () => null }, json: () => ({}), text: () => "" });
    const { deleteItem } = await import("@/lib/integrations/microsoft-files");
    await deleteItem("u-1", "it-1");
    expect(mockRecordAuditFiles).toHaveBeenCalledWith(
      expect.objectContaining({ action: "files.deleted", resourceId: "it-1" }),
    );
    // DELETE on cache row
    const deleteCall = mockQueryFiles.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("DELETE FROM instinct_ms_files_metadata"));
    expect(deleteCall).toBeTruthy();
  });
});
