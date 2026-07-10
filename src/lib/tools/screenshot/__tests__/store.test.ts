const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { storeScreenshot, getScreenshot } from "@/lib/tools/screenshot/store";

beforeEach(() => jest.clearAllMocks());

describe("storeScreenshot", () => {
  it("inserts base64 + byte size and records analytics", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [{ id: "shot-1" }] });
    const png = Buffer.from("hello-png-bytes");
    const out = await storeScreenshot({
      workspaceId: "ws-1",
      createdBy: "u-1",
      sourceUrl: "https://example.com",
      png,
    });
    expect(out).toEqual({ id: "shot-1", byteSize: png.length });
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params).toEqual([
      "ws-1",
      "u-1",
      "https://example.com",
      png.toString("base64"),
      png.length,
    ]);
    expect(mockTrack).toHaveBeenCalledWith(
      "tools.screenshot_captured",
      "u-1",
      "system",
      expect.objectContaining({ workspace_id: "ws-1", byte_size: png.length }),
    );
  });
});

describe("getScreenshot", () => {
  it("returns the stored shot, workspace-scoped", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ content_type: "image/png", data_base64: "AAAA", byte_size: 3 }],
    });
    const r = await getScreenshot("shot-1", "ws-1");
    expect(r).toEqual({ contentType: "image/png", dataBase64: "AAAA", byteSize: 3 });
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params).toEqual(["shot-1", "ws-1"]);
  });

  it("returns null across tenants / when missing", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getScreenshot("shot-1", "other-ws")).toBeNull();
  });
});
