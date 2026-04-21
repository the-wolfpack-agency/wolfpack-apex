/**
 * MS Graph sync — files (OneDrive) worker.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockListFilesDelta = jest.fn();
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ms-graph/client", () => ({
  listFilesDelta: (...a: any[]) => mockListFilesDelta(...a),
  GraphClientError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
      this.name = "GraphClientError";
    }
  },
  describeGraphError: (err: any) =>
    err && err.name === "GraphClientError"
      ? { code: err.code, status: err.status, message: err.message }
      : { code: "unknown", status: 0, message: (err as Error)?.message },
}));

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: (...a: any[]) => mockQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  pool: { query: jest.fn() },
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [] });
  mockQuery.mockResolvedValue({ rows: [{ id: "r" }] });
  mockWriteQuery.mockResolvedValue({ rows: [{ inserted: true }] });
});

describe("files sync worker", () => {
  it("upserts name, webUrl, size_bytes, mime_type, drive_id", async () => {
    mockListFilesDelta.mockResolvedValueOnce({
      items: [
        {
          id: "f-1",
          name: "plan.docx",
          webUrl: "https://onedrive/plan.docx",
          size: 2048,
          file: { mimeType: "application/vnd.docx" },
          parentReference: { driveId: "drv-1", path: "/drive/root:/docs" },
          lastModifiedDateTime: "2026-04-19T10:00:00Z",
        },
      ],
      nextDeltaLink: "https://x/file-delta",
    });
    const { syncUser } = await import("@/lib/ms-graph/sync/files");
    const res = await syncUser("u-1");
    expect(res.created).toBe(1);
    const upsert = mockWriteQuery.mock.calls.find(([sql]) =>
      /INSERT INTO instinct_ms_files/.test(sql),
    );
    expect(upsert[1][2]).toBe("plan.docx"); // subject
    expect(upsert[1][4]).toBe("drv-1"); // drive_id
    expect(upsert[1][6]).toBe(2048); // size_bytes
    expect(upsert[1][7]).toBe("application/vnd.docx"); // mime_type
  });

  it("update path (xmax != 0) → updated++", async () => {
    mockListFilesDelta.mockResolvedValueOnce({
      items: [{ id: "f-1", name: "plan.docx" }],
      nextDeltaLink: "https://x/file-delta",
    });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ inserted: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "log" }] })
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] });
    const { syncUser } = await import("@/lib/ms-graph/sync/files");
    const res = await syncUser("u-1");
    expect(res.updated).toBe(1);
  });
});
