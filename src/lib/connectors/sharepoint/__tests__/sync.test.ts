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

import { syncSource, SYNC_TIME_BUDGET_MS } from "@/lib/connectors/sharepoint/sync";
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
  /* A real source always carries one; admin-only is the database default. */
  audienceRoles: ["admin"],
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
      expect.arrayContaining([
        "sharepoint",
        "sp-source:src-1",
        `sp-source-name:${source.name}`,
        "workspace:ws-1",
      ]),
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

  test("oversized non-media files skipped before downloading (OOM guard)", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      { id: "f1", name: "small.pdf", size: 1024, file: { mimeType: "application/pdf" } },
      { id: "f2", name: "huge.zip", size: 500 * 1024 * 1024, file: { mimeType: "application/zip" } },
    ]);
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("ok"));
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 2 });

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });
    /* Small file ingested, huge zip skipped without download. No
     * placeholder for non-media types. */
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledWith("u1", "drive-xyz", "f1");
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.status).toBe("partial");
    /* Per-file failure surfaced into the job-level error so the UI
     * isn't left with a null reason. */
    expect(result.error).toContain("huge.zip");
    expect(result.error).toContain("file too large");
    const skipCall = mockTrackEvent.mock.calls.find((c) =>
      c[0] === "connectors.sharepoint.file_ingest_failed" &&
      c[3]?.file_name === "huge.zip",
    );
    expect(skipCall?.[3]?.error).toBe("file_too_large_skipped_before_download");
  });

  test("oversized VIDEO files get a placeholder text doc ingested (searchable by name)", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue([
      {
        id: "f-video",
        name: "training-master.mp4",
        size: 500 * 1024 * 1024,
        webUrl: "https://x.sharepoint.com/sites/Y/Shared%20Documents/training-master.mp4",
        parentReference: { path: "/drives/D/root:/Shared Documents/Training" },
        file: { mimeType: "video/mp4" },
      },
    ]);
    const downloadFn = jest.fn();
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 200 });

    const result = await syncSource(source, "u1", "cto", { repo, walkFn, downloadFn, ingestFn });

    /* Download was NOT called — we never pull the huge bytes. */
    expect(downloadFn).not.toHaveBeenCalled();
    /* ingestFn was called with a placeholder doc whose body contains
     * the video metadata so chat queries surface the file by name. */
    expect(ingestFn).toHaveBeenCalledTimes(1);
    const ingestArgs = ingestFn.mock.calls[0][0];
    expect(ingestArgs.filename).toBe("training-master.mp4.placeholder.txt");
    expect(ingestArgs.contentType).toBe("text/plain");
    expect(ingestArgs.tags).toEqual(expect.arrayContaining(["sp-video-placeholder"]));
    /* Source name is in the tag list so chat retrieval can filter
     * by SharePoint site without needing to embed the name string. */
    expect(ingestArgs.tags).toEqual(expect.arrayContaining([`sp-source-name:${source.name}`]));
    const body = ingestArgs.buffer.toString("utf-8");
    expect(body).toContain("training-master.mp4");
    expect(body).toContain("video/mp4");
    expect(body).toContain("https://x.sharepoint.com/sites/Y/Shared%20Documents/training-master.mp4");
    /* CRITICAL for retrieval: the source site name appears as a
     * natural-language token in the body so a chat query like
     * "what videos do we have for {sourceName}" embeds + retrieves
     * this doc. Without this, embeddings have nothing to match
     * against the site name. */
    expect(body).toContain(source.name);
    expect(body).toContain("Video from the");
    /* Folder breadcrumb is human-readable so each folder name
     * becomes a searchable token ("Training", "Options Content"). */
    expect(body).toContain("Shared Documents / Training");

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.status).toBe("succeeded");
    /* Placeholder-indexed analytics event fired. */
    const placeholderCall = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "connectors.sharepoint.placeholder_indexed",
    );
    expect(placeholderCall).toBeDefined();
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

/* ---------------------------------------------------------------------
 * The connector ran once, on 2026-05-16, and has not run since. The job rows
 * say why: "873 file(s) failed", almost every one download_failed_429, and ten
 * more jobs killed by the reconciler at six minutes.
 *
 * Graph throttles bulk reads. Treating a throttle as a permanent failure meant
 * the corpus never arrived, which is why the Brain holds learning journals and
 * receipts while people ask product questions.
 * --------------------------------------------------------------- */
import { backoffMs } from "@/lib/connectors/sharepoint/sync";

describe("waiting out a throttle", () => {
  it("obeys Retry-After, because it is the service saying when it will serve you", () => {
    expect(backoffMs(0, "12")).toBe(12_000);
    expect(backoffMs(3, "5")).toBe(5_000);
  });

  it("backs off exponentially when Graph does not say", () => {
    expect(backoffMs(0, null)).toBe(1_000);
    expect(backoffMs(1, null)).toBe(2_000);
    expect(backoffMs(2, null)).toBe(4_000);
  });

  /* One hostile or mistaken header must not stall an entire run. */
  it("caps a single wait", () => {
    expect(backoffMs(0, "3600")).toBe(30_000);
    expect(backoffMs(20, null)).toBe(30_000);
  });

  it("ignores a header that is not a number", () => {
    expect(backoffMs(1, "soon")).toBe(2_000);
  });
});

describe("a sync that has run before", () => {
  const twoFiles = [
    { id: "f1", name: "doc1.pdf", size: 100, file: { mimeType: "application/pdf" } },
    { id: "f2", name: "doc2.pdf", size: 200, file: { mimeType: "application/pdf" } },
  ];

  it("does not download what a previous run already landed", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue(twoFiles);
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("hello"));
    const ingestFn = jest.fn().mockResolvedValue({
      document_id: "doc", status: "indexed", chunk_count: 1, extracted_chars: 5,
    });
    const alreadyIngestedFn = jest.fn().mockResolvedValue(new Set(["f1"]));

    const result = await syncSource(source, "u1", "cto", {
      repo, walkFn, downloadFn, ingestFn, alreadyIngestedFn,
    });

    /* The whole point: the expensive, rate-limited call is not made. */
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(ingestFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(result.failCount).toBe(0);
  });

  /* Asked once for the folder, not once per file: nine hundred round trips
     before the first download is the shape of problem being escaped. */
  it("asks about the whole folder in one go", async () => {
    const repo = fakeRepo();
    const alreadyIngestedFn = jest.fn().mockResolvedValue(new Set<string>());
    await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue(twoFiles),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn: jest.fn().mockResolvedValue({
        document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 1,
      }),
      alreadyIngestedFn,
    });
    expect(alreadyIngestedFn).toHaveBeenCalledTimes(1);
    expect(alreadyIngestedFn).toHaveBeenCalledWith(["f1", "f2"]);
  });

  /* The resume key itself. Null on all 1,112 production documents, which is
     why no sync has ever been able to pick up where it left off. */
  it("records which drive item each document came from", async () => {
    const repo = fakeRepo();
    const ingestFn = jest.fn().mockResolvedValue({
      document_id: "d", status: "indexed", chunk_count: 1, extracted_chars: 1,
    });
    await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue([twoFiles[0]]),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn,
      alreadyIngestedFn: jest.fn().mockResolvedValue(new Set<string>()),
    });
    expect(ingestFn).toHaveBeenCalledWith(
      expect.objectContaining({ msDriveItemId: "f1" }),
    );
  });
});

/**
 * Stopping before the platform stops us.
 *
 * The sync route is synchronous with maxDuration=300. Vercel enforces that by
 * KILLING the function, which happens mid-statement: finishJob() never runs,
 * the job row keeps status='running' with a null ended_at, and the admin UI
 * reads "Syncing..." forever. The TEST source has looked that way since
 * 2026-05-16. On 2026-08-27 it was manually cleared three times and hung again
 * within seconds of each clear, because clearing a row does nothing about a
 * folder being bigger than one invocation.
 *
 * The work was ALREADY resumable: every file the Brain holds is skipped by
 * drive-item id, so a second run continues rather than restarting. What was
 * missing was ending the first run on purpose.
 */
describe("the time budget", () => {
  function files(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `f${i}`, name: `file${i}.txt`, size: 10,
      webUrl: `https://x/${i}`, file: { mimeType: "text/plain" },
    }));
  }

  test("stops on the budget and reports the rest as remaining, not as done", async () => {
    const repo = fakeRepo();
    const walkFn = jest.fn().mockResolvedValue(files(5));
    const downloadFn = jest.fn().mockResolvedValue(Buffer.from("x"));
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "d" });
    /* Clock jumps past the deadline after the second file. */
    let t = 0;
    const now = () => (t += 100);

    const result = await syncSource(source, "u1", "cto", {
      repo, walkFn, downloadFn, ingestFn, budgetMs: 250, now,
      alreadyIngestedFn: async () => new Set(),
    });

    expect(result.moreRemaining).toBe(true);
    expect(result.remainingCount).toBeGreaterThan(0);
    /* NOT "succeeded". Every file it touched worked, and saying succeeded
       would tell the operator the folder is done. */
    expect(result.status).toBe("partial");
    expect(ingestFn.mock.calls.length).toBeLessThan(5);
  });

  test("closes the job row rather than leaving it running", async () => {
    /* THE WHOLE POINT. A killed function never reaches finishJob, which is why
       TEST has read "Syncing..." for three months. */
    const repo = fakeRepo();
    let t = 0;
    await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue(files(5)),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn: jest.fn().mockResolvedValue({ document_id: "d" }),
      budgetMs: 150, now: () => (t += 100),
      alreadyIngestedFn: async () => new Set(),
    });
    expect(repo.finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "partial" }));
  });

  test("says in the job error how to continue, because the UI renders that field", async () => {
    const repo = fakeRepo();
    let t = 0;
    await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue(files(5)),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn: jest.fn().mockResolvedValue({ document_id: "d" }),
      budgetMs: 150, now: () => (t += 100),
      alreadyIngestedFn: async () => new Set(),
    });
    const arg = repo.finishJob.mock.calls[0][1];
    expect(String(arg.error)).toMatch(/Run the sync again/i);
    expect(String(arg.error)).toMatch(/skipped/i);
  });

  test("a second run resumes instead of restarting", async () => {
    /* The half that already worked, pinned so a budget change cannot break it.
       Files the Brain holds are skipped by drive-item id. */
    const repo = fakeRepo();
    const ingestFn = jest.fn().mockResolvedValue({ document_id: "d" });
    const result = await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue(files(4)),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn,
      alreadyIngestedFn: async () => new Set(["f0", "f1", "f2"]),
    });
    expect(result.skippedCount).toBe(3);
    expect(ingestFn).toHaveBeenCalledTimes(1);
    expect(result.moreRemaining).toBe(false);
  });

  test("a folder that fits reports succeeded and nothing remaining", async () => {
    /* The negative. A budget that fired on every run would make every sync
       look partial and the signal would mean nothing. */
    const repo = fakeRepo();
    const result = await syncSource(source, "u1", "cto", {
      repo,
      walkFn: jest.fn().mockResolvedValue(files(3)),
      downloadFn: jest.fn().mockResolvedValue(Buffer.from("x")),
      ingestFn: jest.fn().mockResolvedValue({ document_id: "d" }),
      alreadyIngestedFn: async () => new Set(),
    });
    expect(result.status).toBe("succeeded");
    expect(result.moreRemaining).toBe(false);
    expect(result.remainingCount).toBe(0);
  });

  test("the default budget leaves room to finish inside the route's 300s ceiling", async () => {
    /* A budget at or above the ceiling is the same as having none. */
    expect(SYNC_TIME_BUDGET_MS).toBeLessThanOrEqual(250_000);
    expect(SYNC_TIME_BUDGET_MS).toBeGreaterThanOrEqual(120_000);
  });
});
