/**
 * Sync orchestrator tests. Mocks the walker, downloader, ingest fn,
 * and repo. Validates the contract guarantees:
 *   - Job row always written (started + finished)
 *   - File-level failures don't abort the run
 *   - Status resolves correctly based on success/fail counts
 *   - Analytics events fire at the right boundaries
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  graphFetch: jest.fn(),
  getValidToken: jest.fn().mockResolvedValue({ accessToken: "tok", userEmail: "u@x.co" }),
}));
jest.mock("@/lib/brain/ingest", () => ({
  ingest: jest.fn(),
}));

import { syncSource } from "@/lib/connectors/sharepoint/sync";
import type { SharepointSource } from "@/lib/connectors/sharepoint/types";

const source: SharepointSource = {
  id: "src-1",
  workspaceId: "ws-1",
  name: "PCNA Evals",
  siteUrl: "https://x.sharepoint.com/sites/PCNAINTERNAL",
  siteId: "site-abc",
  driveId: "drive-xyz",
  folderPath: "Shared Documents/Program Evals",
  createdBy: "u1",
  createdAt: "2026-05-16T00:00:00Z",
  lastSyncedAt: null,
  isActive: true,
};

function fakeRepo() {
  return {
    startJob: jest.fn().mockResolvedValue({
      id: "job-1", sourceId: "src-1", triggeredBy: "u1",
      startedAt: "x", endedAt: null, status: "running",
      fileCount: 0, successCount: 0, failCount: 0, bytesIngested: 0, error: null,
    }),
    finishJob: jest.fn().mockResolvedValue(undefined),
    touchLastSynced: jest.fn().mockResolvedValue(undefined),
    insertSource: jest.fn(), listSources: jest.fn(), getSource: jest.fn(),
    deactivateSource: jest.fn(), listJobsForSource: jest.fn(),
    reconcileStuckJobs: jest.fn().mockResolvedValue(0),
  };
}

beforeEach(() => {
  mockTrackEvent.mockClear();
});

describe("syncSource", () => {
  test("happy path: walks folder, ingests every file, marks succeeded", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      { id: "f1", name: "doc1.pdf", size: 100, file: { mimeType: "application/pdf" } },
      { id: "f2", name: "doc2.docx", size: 200, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } },
    ]);
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("hello"));
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "doc", status: "indexed", chunk_count: 1, extracted_chars: 5 });

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });

    expect(result.status).toBe("succeeded");
    expect(result.fileCount).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.bytesIngested).toBe(10); // "hello" twice = 10 bytes
    expect(repo.startJob).toHaveBeenCalledWith("src-1", "u1");
    expect(repo.finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({
      status: "succeeded", fileCount: 2, successCount: 2, failCount: 0,
    }));
    expect(repo.touchLastSynced).toHaveBeenCalledWith("src-1");
    expect(ingestFn).toHaveBeenCalledTimes(2);
    /* Confirms the brain-ingest tag chain includes provenance for the
       learning loop. */
    expect(ingestFn.mock.calls[0][0].tags).toEqual(
      expect.arrayContaining(["sharepoint", "sp-source:src-1", "workspace:ws-1"]),
    );
  });

  test("partial failure: one file ingest throws, run completes with status=partial", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      { id: "f1", name: "ok.pdf", file: { mimeType: "application/pdf" } },
      { id: "f2", name: "bad.docx", file: { mimeType: "x" } },
    ]);
    const downloadFn = jest.fn()
      .mockResolvedValueOnce(Buffer.from("ok"))
      .mockResolvedValueOnce(Buffer.from("bad"));
    const ingestFn = jest.fn()
      .mockResolvedValueOnce({ document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 2 })
      .mockRejectedValueOnce(new Error("extract_failed"));

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });
    expect(result.status).toBe("partial");
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "connectors.sharepoint.file_ingest_failed", "u1", "cto",
      expect.objectContaining({ file_name: "bad.docx" }),
    );
    /* touchLastSynced still fires on partial (we did get SOME data
       ingested; the failures are surfaced through file_ingest_failed). */
    expect(repo.touchLastSynced).toHaveBeenCalled();
  });

  test("all-failures: every file fails to ingest, status=failed", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      { id: "f1", name: "a.pdf", file: { mimeType: "x" } },
    ]);
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("x"));
    const ingestFn = jest.fn().mockRejectedValue(new Error("boom"));

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });
    expect(result.status).toBe("failed");
    expect(repo.touchLastSynced).not.toHaveBeenCalled();
  });

  test("walk throws: top-level error captured, status=failed, file_count=0", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockRejectedValue(new Error("no_token"));
    const ingestFn = jest.fn();

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, ingestFn });
    expect(result.status).toBe("failed");
    expect(result.fileCount).toBe(0);
    expect(result.error).toBe("no_token");
    expect(ingestFn).not.toHaveBeenCalled();
    expect(repo.touchLastSynced).not.toHaveBeenCalled();
  });

  test("empty folder: zero files, status=succeeded (no failures)", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([]);
    const ingestFn = jest.fn();

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, ingestFn });
    expect(result.status).toBe("succeeded");
    expect(result.fileCount).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(0);
  });

  test("skips files larger than BRAIN_MAX_SIZE_BYTES BEFORE downloading (OOM guard)", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      { id: "f1", name: "small.pdf", size: 1024, file: { mimeType: "application/pdf" } },
      { id: "f2", name: "huge-video.mp4", size: 500 * 1024 * 1024, file: { mimeType: "video/mp4" } },
    ]);
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("ok"));
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 2 });

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });
    /* Small file ingested, huge file skipped without download. */
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledWith("u1", "drive-xyz", "f1");
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.status).toBe("partial");
    /* Analytics records the size-skip with a clear error code. */
    const skipCall = mockTrackEvent.mock.calls.find((c) =>
      c[0] === "connectors.sharepoint.file_ingest_failed" &&
      c[3]?.file_name === "huge-video.mp4",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall?.[3]?.error).toBe("file_too_large_skipped_before_download");
  });

  test("fires sync_started + sync_finished analytics", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([]);
    await syncSource(source, "u1", "cto", { repo, walkFn });
    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("connectors.sharepoint.sync_started");
    expect(events).toContain("connectors.sharepoint.sync_finished");
  });
});
