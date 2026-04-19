/**
 * client-assets.ts unit tests.
 *
 * Mocks:
 *   - @/lib/db (safeQuery, writeQuery, WriteQueryError) — the write
 *     path is the strict-throw one; writeQuery failures must propagate.
 *   - @/lib/analytics (trackEvent) — asserts we emit the right events
 *     with the right metadata shape.
 *
 * The engineering directive is explicit: every write goes through
 * writeQuery with expectRows: 1 where applicable, and a
 * WriteQueryError thrown by the helper must bubble up unchanged (the
 * API route converts it to 500 only at the boundary).
 */

const safeQueryMock = jest.fn();
const writeQueryMock = jest.fn();
const trackMock = jest.fn();

class MockWriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  readonly expected?: number;
  readonly actual?: number;
  constructor(
    message: string,
    code: "no_database" | "db_error" | "unexpected_row_count",
    extra?: { expected?: number; actual?: number },
  ) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
    this.expected = extra?.expected;
    this.actual = extra?.actual;
  }
}

jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
  writeQuery: (...args: unknown[]) => writeQueryMock(...args),
  WriteQueryError: MockWriteQueryError,
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => trackMock(...args),
}));

import {
  listAssetsForClient,
  recordAssetUpload,
  recordAssetUsage,
  softDeleteAsset,
  getAssetById,
} from "@/lib/client-assets";

function mkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a_1",
    client_slug: "acme",
    asset_kind: "logo",
    filename: "logo.png",
    url: "/api/clients/acme/assets/a_1/raw",
    mime: "image/png",
    size_bytes: 12345,
    sha256: "hash_1",
    alt_text: null,
    use_count: 1,
    last_used_at: null,
    uploaded_at: "2026-04-19T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listAssetsForClient", () => {
  it("returns rows sorted by last_used_at DESC (via SQL ORDER BY)", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        mkRow({ id: "a_recent", last_used_at: "2026-04-19T10:00:00Z" }),
        mkRow({ id: "a_stale", last_used_at: "2026-04-01T00:00:00Z" }),
        mkRow({ id: "a_never", last_used_at: null }),
      ],
      fromCache: false,
    });
    const assets = await listAssetsForClient("acme");
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/ORDER BY last_used_at DESC NULLS LAST/);
    expect(assets[0].id).toBe("a_recent");
    expect(assets[2].id).toBe("a_never");
  });

  it("filters out deleted rows via WHERE deleted_at IS NULL", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await listAssetsForClient("acme");
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("deleted_at IS NULL");
  });

  it("applies the kind filter when provided", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await listAssetsForClient("acme", { kind: "logo" });
    const [sql, params] = safeQueryMock.mock.calls[0];
    expect(String(sql)).toContain("asset_kind");
    expect(params).toContain("logo");
  });

  it("returns [] without querying when kind is invalid", async () => {
    const res = await listAssetsForClient("acme", {
      // deliberately cast — runtime defensive check
      kind: "nope" as unknown as "logo",
    });
    expect(res).toEqual([]);
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});

describe("recordAssetUpload — fresh insert", () => {
  it("INSERTs when sha256 not seen before, returns row, tracks uploaded with deduped:false", async () => {
    // Dedupe SELECT returns empty.
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "a_new", sha256: "fresh_hash" })],
    });

    const asset = await recordAssetUpload({
      clientSlug: "acme",
      assetKind: "logo",
      filename: "logo.png",
      url: "/api/clients/acme/assets/a_new/raw",
      mime: "image/png",
      sizeBytes: 12345,
      sha256: "fresh_hash",
      uploadedBy: "u_1",
    });

    expect(asset.id).toBe("a_new");
    expect(asset.sha256).toBe("fresh_hash");
    // writeQuery called with expectRows: 1
    expect(writeQueryMock).toHaveBeenCalledTimes(1);
    expect(writeQueryMock.mock.calls[0][2]).toEqual({ expectRows: 1 });
    // Analytics: deduped:false
    expect(trackMock).toHaveBeenCalledWith(
      "client_asset_uploaded",
      "u_1",
      "unknown",
      expect.objectContaining({
        client_slug: "acme",
        kind: "logo",
        size_bytes: 12345,
        deduped: false,
      }),
    );
  });

  it("rejects invalid asset_kind before touching the database", async () => {
    await expect(
      recordAssetUpload({
        clientSlug: "acme",
        // @ts-expect-error — runtime defensive check
        assetKind: "bogus",
        filename: "x.png",
        url: "u",
        mime: "image/png",
        sizeBytes: 1,
        sha256: "h",
      }),
    ).rejects.toThrow(/invalid asset_kind/);
    expect(safeQueryMock).not.toHaveBeenCalled();
    expect(writeQueryMock).not.toHaveBeenCalled();
  });

  it("uses caller-supplied id when provided (lets route embed URL pre-insert)", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "caller_id" })],
    });
    await recordAssetUpload({
      id: "caller_id",
      clientSlug: "acme",
      assetKind: "logo",
      filename: "x.png",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "h",
    });
    const params = writeQueryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("caller_id");
  });

  it("propagates WriteQueryError from the helper without swallowing", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    writeQueryMock.mockRejectedValueOnce(
      new MockWriteQueryError("insert blew up", "db_error"),
    );
    await expect(
      recordAssetUpload({
        clientSlug: "acme",
        assetKind: "logo",
        filename: "x.png",
        url: "u",
        mime: "image/png",
        sizeBytes: 1,
        sha256: "h",
      }),
    ).rejects.toMatchObject({ name: "WriteQueryError", code: "db_error" });
  });
});

describe("recordAssetUpload — dedupe", () => {
  it("returns existing row + increments use_count when sha256 already exists", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "existing", use_count: 3, sha256: "dup_hash" })],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "existing", use_count: 4, sha256: "dup_hash" })],
    });
    const asset = await recordAssetUpload({
      clientSlug: "acme",
      assetKind: "logo",
      filename: "whatever.png",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "dup_hash",
      uploadedBy: "u_1",
    });
    expect(asset.id).toBe("existing");
    expect(asset.useCount).toBe(4);
    // One writeQuery — the UPDATE. No INSERT.
    expect(writeQueryMock).toHaveBeenCalledTimes(1);
    const sql = writeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE instinct_client_assets");
    expect(sql).toContain("use_count = use_count + 1");
    // Analytics: deduped:true
    expect(trackMock).toHaveBeenCalledWith(
      "client_asset_uploaded",
      "u_1",
      "unknown",
      expect.objectContaining({ deduped: true }),
    );
  });

  it("dedupe UPDATE uses expectRows:1 so a silent view-discard throws", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "existing" })],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "existing", use_count: 2 })],
    });
    await recordAssetUpload({
      clientSlug: "acme",
      assetKind: "logo",
      filename: "x.png",
      url: "u",
      mime: "image/png",
      sizeBytes: 1,
      sha256: "h",
    });
    expect(writeQueryMock.mock.calls[0][2]).toEqual({ expectRows: 1 });
  });
});

describe("recordAssetUsage", () => {
  it("increments use_count, updates last_used_at, tracks client_asset_reused", async () => {
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "a_1", use_count: 5, last_used_at: "2026-04-19T12:00:00Z" })],
    });
    await recordAssetUsage("a_1", {
      siteId: "site_42",
      userId: "u_1",
      userRole: "sales",
    });
    const sql = writeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE instinct_client_assets");
    expect(sql).toContain("use_count = use_count + 1");
    expect(sql).toContain("last_used_at = NOW()");
    expect(writeQueryMock.mock.calls[0][2]).toEqual({ expectRows: 1 });
    expect(trackMock).toHaveBeenCalledWith(
      "client_asset_reused",
      "u_1",
      "sales",
      expect.objectContaining({
        client_slug: "acme",
        asset_id: "a_1",
        site_id: "site_42",
        kind: "logo",
      }),
    );
  });

  it("propagates WriteQueryError when the asset is already deleted (0 rows)", async () => {
    writeQueryMock.mockRejectedValueOnce(
      new MockWriteQueryError("no rows", "unexpected_row_count", {
        expected: 1,
        actual: 0,
      }),
    );
    await expect(recordAssetUsage("gone")).rejects.toMatchObject({
      code: "unexpected_row_count",
    });
  });
});

describe("softDeleteAsset", () => {
  it("flips deleted_at, tracks client_asset_deleted, uses expectRows:1", async () => {
    writeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "a_1" })],
    });
    await softDeleteAsset("a_1", { userId: "u_1", userRole: "sales" });
    const sql = writeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE instinct_client_assets");
    expect(sql).toContain("deleted_at = NOW()");
    expect(writeQueryMock.mock.calls[0][2]).toEqual({ expectRows: 1 });
    expect(trackMock).toHaveBeenCalledWith(
      "client_asset_deleted",
      "u_1",
      "sales",
      expect.objectContaining({ client_slug: "acme", asset_id: "a_1" }),
    );
  });

  it("won't re-delete an already-deleted asset (WriteQueryError propagates)", async () => {
    writeQueryMock.mockRejectedValueOnce(
      new MockWriteQueryError("no rows", "unexpected_row_count", {
        expected: 1,
        actual: 0,
      }),
    );
    await expect(softDeleteAsset("a_gone")).rejects.toMatchObject({
      code: "unexpected_row_count",
    });
  });
});

describe("getAssetById", () => {
  it("returns null when no row", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    expect(await getAssetById("nope")).toBeNull();
  });

  it("returns the row in camelCase shape", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [mkRow({ id: "a_1", alt_text: "brand logo" })],
      fromCache: false,
    });
    const asset = await getAssetById("a_1");
    expect(asset).not.toBeNull();
    expect(asset!.altText).toBe("brand logo");
    expect(asset!.clientSlug).toBe("acme");
  });
});
