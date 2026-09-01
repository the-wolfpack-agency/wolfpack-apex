/**
 * A fix that never reaches the rows it was written for has not happened.
 *
 * Ninety Word documents, every .docx in the Brain, sat at status=failed with a
 * parser error that was fixed on 2026-08-25. They were last touched on
 * 2026-06-10. The diff was merged, the corpus was never re-run, and for three
 * months the product could not quote a single Word document while the commit
 * log said it could.
 *
 * These tests pin the two halves that made that possible: choosing candidates
 * by a reason somebody has actually fixed (rather than retrying everything, or
 * nothing), and re-extracting IN PLACE, because ingest() dedupes on the sha and
 * hands back the very failure being repaired.
 */

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockUpdateStatus = jest.fn();
const mockUpdateStats = jest.fn();
const mockDeleteChunks = jest.fn();
const mockInsertChunks = jest.fn();
const mockMarkEmbedded = jest.fn();
const mockRecordJob = jest.fn();
const mockDeleteByDoc = jest.fn();
const mockUpsert = jest.fn();
const mockExtract = jest.fn();
const mockOcrImage = jest.fn();
const mockVisionConfigured = jest.fn();
const mockEmbedConfigured = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("../repo", () => ({
  deleteChunksForDocument: (...a: unknown[]) => mockDeleteChunks(...a),
  insertChunks: (...a: unknown[]) => mockInsertChunks(...a),
  markChunksEmbedded: (...a: unknown[]) => mockMarkEmbedded(...a),
  recordJob: (...a: unknown[]) => mockRecordJob(...a),
  updateDocumentStats: (...a: unknown[]) => mockUpdateStats(...a),
  updateDocumentStatus: (...a: unknown[]) => mockUpdateStatus(...a),
}));
jest.mock("../qdrant", () => ({
  upsertBrainPoints: (...a: unknown[]) => mockUpsert(...a),
  deleteByDocumentId: (...a: unknown[]) => mockDeleteByDoc(...a),
}));
jest.mock("../embedder", () => ({
  isEmbeddingConfigured: () => mockEmbedConfigured(),
  embedBatch: jest.fn(),
}));
jest.mock("../extractor", () => ({
  ...jest.requireActual("../extractor"),
  extract: (...a: unknown[]) => mockExtract(...a),
}));
jest.mock("@/lib/azure/vision-ocr", () => ({
  ocrImage: (...a: unknown[]) => mockOcrImage(...a),
  isVisionConfigured: () => mockVisionConfigured(),
}));
jest.mock("../chunker", () => ({
  chunkText: (t: string) => [{ content: t, token_estimate: 10 }],
}));

import { findCandidates, reprocessFixable, FIXABLE, MAX_REPAIR_BYTES } from "../reprocess";

const ACTOR = { userId: "u1", role: "cto" };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    filename: "SOW.docx",
    kind: "docx",
    status: "failed",
    status_detail: 'DOMParser.parseFromString: the provided mimeType "undefined" is not valid',
    ms_drive_item_id: "drive-1",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbedConfigured.mockReturnValue(false);
  mockVisionConfigured.mockReturnValue(false);
  mockDeleteByDoc.mockResolvedValue(undefined);
  mockDeleteChunks.mockResolvedValue(1);
  mockUpsert.mockResolvedValue(undefined);
  mockUpdateStatus.mockResolvedValue(undefined);
  mockUpdateStats.mockResolvedValue(undefined);
  mockRecordJob.mockResolvedValue(undefined);
  mockMarkEmbedded.mockResolvedValue(undefined);
  mockExtract.mockResolvedValue({ ok: true, text: "Statement of work. Net thirty days." });
  mockInsertChunks.mockResolvedValue([{ id: "c1", chunk_idx: 0, content: "x" }]);
  mockQuery.mockResolvedValue({ rows: [row()] });
});

describe("choosing what to retry", () => {
  it("retries the docx parser failure, which is the ninety", async () => {
    const c = await findCandidates();
    expect(c).toHaveLength(1);
    expect(c[0].reason).toBe("docx_mimetype");
  });

  it("retries a document skipped for want of an extractor that now exists", async () => {
    mockQuery.mockResolvedValue({
      rows: [row({ kind: "other", filename: "deck.xlsx", status: "skipped", status_detail: "sync extractor unavailable for other" })],
    });
    expect((await findCandidates())[0].reason).toBe("extractor_now_exists");
  });

  it("does NOT retry a genuinely scanned PDF", async () => {
    /* Sixty-two of these exist. Retrying them re-downloads the whole set on
       every run, ends in the same state, and teaches whoever reads the report
       to ignore it. They need OCR, which is a different change. */
    mockQuery.mockResolvedValue({
      rows: [row({ kind: "pdf", status: "failed", status_detail: "PDF contained no extractable text (scanned?)" })],
    });
    expect(await findCandidates()).toHaveLength(0);
  });

  it("retries a document stranded in a non-terminal state", async () => {
    /* Ten PDFs sat in "chunking" from May to August. Nothing was ever going to
       move them, because nothing was looking. */
    mockQuery.mockResolvedValue({ rows: [row({ status: "chunking", status_detail: null })] });
    expect((await findCandidates())[0].reason).toBe("stranded in chunking");
  });

  it("every fixable reason carries why it is fixable", () => {
    /* A retry allowlist without reasons becomes a blanket retry one entry at a
       time, and nobody can argue with a line that does not say why. */
    for (const f of FIXABLE) expect(f.why.length).toBeGreaterThan(20);
  });
});

describe("repairing in place", () => {
  const fetchBytes = async () => Buffer.from("PK bytes");

  it("re-extracts and lands the document indexed", async () => {
    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(r.repaired).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ before: "failed", after: "indexed", chunks: 1 });
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "indexed", null);
  });

  it("clears old chunks AND old vectors before writing new ones", async () => {
    /* A repair that appends leaves the document quoted twice, once from the
       broken extraction it was supposed to replace. */
    await reprocessFixable(fetchBytes, ACTOR);
    expect(mockDeleteChunks).toHaveBeenCalledWith("d1");
    expect(mockDeleteByDoc).toHaveBeenCalledWith("d1");
  });

  it("reclassifies from the filename rather than trusting the stored kind", async () => {
    /* Twenty-seven files named .xlsx are stored as kind "other". Trusting the
       stored kind preserves the misclassification forever. */
    mockQuery.mockResolvedValue({
      rows: [row({ kind: "other", filename: "survey.xlsx", status: "skipped", status_detail: "sync extractor unavailable for other" })],
    });
    await reprocessFixable(fetchBytes, ACTOR);
    expect(mockExtract).toHaveBeenCalledWith("xlsx", expect.any(Buffer));
  });

  it("records a document with nowhere to re-fetch from instead of retrying it forever", async () => {
    mockQuery.mockResolvedValue({ rows: [row({ ms_drive_item_id: null })] });
    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(r.skippedNoDriveItem).toBe(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "failed", expect.stringMatching(/re-upload/));
  });

  it("leaves a still-broken document failed, with the new reason", async () => {
    mockExtract.mockResolvedValue({ ok: false, reason: "failed", detail: "still broken" });
    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(r.repaired).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "failed", "still broken");
  });

  it("does not undo a recovered document when the embedder is dead", async () => {
    /* Keyword search works without vectors. Losing the recovered TEXT because
       the vector store was down would trade a real repair for nothing. */
    mockEmbedConfigured.mockReturnValue(true);
    const { embedBatch } = jest.requireMock("../embedder");
    (embedBatch as jest.Mock).mockRejectedValue(new Error("embedder down"));
    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(r.repaired).toBe(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "indexed", null);
  });

  /* THIS TEST USED TO ASSERT THE BUG. It required the fetch error to be
     written onto the row, which is exactly what erased the diagnosis that made
     the document repairable and dropped it out of the candidate set forever.
     A rate limit or an expired token says something about the connection and
     nothing about the file. The run still reports the failure; it just does
     not record a verdict on a document it never managed to read. */
  it("survives a re-fetch that throws, and reports it without judging the file", async () => {
    const r = await reprocessFixable(async () => { throw new Error("graph 429"); }, ACTOR);
    expect(r.stillFailing).toBe(1);
    expect(r.outcomes[0].detail).toMatch(/graph 429/);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("emits per-document and per-run events, so the repair is measurable", async () => {
    /* The whole reason this module exists is that nothing recorded whether a
       fix had reached its corpus. */
    await reprocessFixable(fetchBytes, ACTOR);
    const names = mockTrack.mock.calls.map((c) => c[0]);
    expect(names).toContain("brain.document_reprocessed");
    expect(names).toContain("brain.reprocess_run");
    const run = mockTrack.mock.calls.find((c) => c[0] === "brain.reprocess_run")!;
    expect(run[3]).toMatchObject({ considered: 1, repaired: 1, still_failing: 0 });
  });
});

/**
 * Scanned pages, and the cost of reading them.
 *
 * Sixty-two PDFs and forty-three images sit in the library with nothing to
 * quote, because the page is a picture. OCR is the first thing here that
 * spends money per DOCUMENT rather than per question, so the policy is asked
 * on this path rather than being a module only its own test calls.
 */
describe("a scan with no extractable text", () => {
  const fetchBytes = async () => Buffer.from("scan bytes");

  function scannedPdf() {
    mockQuery.mockResolvedValue({
      rows: [row({ kind: "pdf", filename: "contract.pdf", status: "failed", status_detail: "sync extractor unavailable for pdf" })],
    });
    mockExtract.mockResolvedValue({ ok: false, reason: "empty", detail: "PDF contained no extractable text (scanned?)" });
  }

  it("is read by the OCR API when it is configured, and lands indexed", async () => {
    scannedPdf();
    mockVisionConfigured.mockReturnValue(true);
    mockOcrImage.mockResolvedValue({ ok: true, text: "This agreement is between the parties." });

    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(r.repaired).toBe(1);
    expect(mockOcrImage).toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "indexed", null);
  });

  it("records what the page cost, per document", async () => {
    scannedPdf();
    mockVisionConfigured.mockReturnValue(true);
    mockOcrImage.mockResolvedValue({ ok: true, text: "text" });

    await reprocessFixable(fetchBytes, ACTOR);
    const ev = mockTrack.mock.calls.find((c) => c[0] === "brain.document_ocred");
    expect(ev).toBeDefined();
    expect(ev![3]).toMatchObject({ route: "vision_api" });
  });

  it("is NOT sent anywhere when no OCR route is configured", async () => {
    /* The honest outcome. Spending nothing and saying the document cannot be
       read beats inventing a route that does not exist. */
    scannedPdf();
    mockVisionConfigured.mockReturnValue(false);

    const r = await reprocessFixable(fetchBytes, ACTOR);
    expect(mockOcrImage).not.toHaveBeenCalled();
    expect(r.repaired).toBe(0);
  });

  it("keeps the OCR failure reason verbatim, so a later run can tell why", async () => {
    /* A page the OCR API REFUSED can be escalated to a vision model. A page it
       could not physically read cannot. Collapsing both to "ocr failed" throws
       away the only signal that distinguishes them. */
    scannedPdf();
    mockVisionConfigured.mockReturnValue(true);
    mockOcrImage.mockResolvedValue({ ok: false, reason: "low_confidence", detail: "handwriting" });

    await reprocessFixable(fetchBytes, ACTOR);
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "failed", expect.stringMatching(/handwriting/));
  });

  it("does not send a .docx to OCR, because a broken parse is not a scan", async () => {
    /* Paying a vision model to confirm a parser bug is the cost of a policy
       that does not distinguish the two. */
    mockVisionConfigured.mockReturnValue(true);
    mockExtract.mockResolvedValue({ ok: false, reason: "failed", detail: "docx parse: broken" });
    await reprocessFixable(fetchBytes, ACTOR);
    expect(mockOcrImage).not.toHaveBeenCalled();
  });
});

/**
 * What `limit` means, and the night it meant something else.
 *
 * THE INCIDENT. The nightly sweep asks the endpoint what is waiting, then asks
 * it to repair. The first call used the endpoint default of 200 and reported
 * 186 documents waiting. The second sent limit 50 and repaired nothing, three
 * nights running, exiting green each time.
 *
 * The cause was ordering: the query took the newest N rows and JavaScript then
 * discarded the ones nothing can fix. So `limit` meant "rows to look at" while
 * every caller read it as "documents to repair", and the newest fifty happened
 * to be scanned PDFs and expired-token rows that no repair addresses.
 *
 *     limit  50  ->    0 candidates      of 186 repairable
 *     limit 100  ->   49
 *     limit 200  ->   98
 *
 * Ninety Word documents of a client's course material sat unreadable behind a
 * job reporting success. Fixability is decided in SQL now, before the limit.
 */
describe("how many documents a repair run takes", () => {
  /* Rows the SQL would return: the caller's limit applied to rows that are
     ALREADY fixable, which is what the new query does. */
  function givenFixable(count: number) {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: count }, (_, i) => ({
        id: `d${i}`,
        filename: `doc-${i}.docx`,
        kind: "docx",
        status: "failed",
        status_detail: 'DOMParser.parseFromString: the provided mimeType "undefined" is not valid',
        ms_drive_item_id: `drive-${i}`,
      })),
    });
  }

  it("asks the database for fixable rows rather than filtering afterwards", async () => {
    givenFixable(50);
    await findCandidates({ limit: 50 });

    const [sql, args] = mockQuery.mock.calls[0];
    /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. The fixability test has to be
       inside the statement, or the LIMIT lands on the wrong set of rows. */
    expect(sql).toMatch(/status_detail\s*~\*/i);
    expect(sql.indexOf("status_detail")).toBeLessThan(sql.indexOf("LIMIT"));
    /* And the patterns come from FIXABLE, so the planner and the repairer
       cannot disagree about what fixable means. */
    expect(args[0]).toEqual(FIXABLE.map((f) => f.source));
  });

  it("returns as many as it was asked for when that many are waiting", async () => {
    givenFixable(50);
    expect(await findCandidates({ limit: 50 })).toHaveLength(50);
  });

  it("returns everything waiting when fewer than the limit remain", async () => {
    givenFixable(7);
    expect(await findCandidates({ limit: 50 })).toHaveLength(7);
  });

  /* Every pattern must be something Postgres can run. A JavaScript-only
     construct would match in the planner and not in the repairer, which is a
     quieter version of the same bug. */
  it("keeps every fixable pattern portable to Postgres", () => {
    for (const f of FIXABLE) {
      expect(f.source).not.toMatch(/\\[dswbDSWB]|\(\?[:=!<]/);
      /* And the two forms have to describe the same set. */
      expect(new RegExp(f.source, "i").source).toBe(f.test.source.replace(/^\/|\/i$/g, ""));
    }
  });
});

/**
 * A repair that could not download must not pass judgment on the file.
 *
 * THE INCIDENT, 2026-09-01. Every Microsoft token expired on 2026-08-26. A run
 * took fifty documents, failed to download all fifty, and rewrote each one's
 * status_detail from "docx mimeType" to "re-fetch failed: no_token".
 *
 * That detail is not in FIXABLE, so all fifty dropped out of the candidate set
 * permanently. The fixable queue fell from 186 to 136 and the no_token pile
 * grew from 37 to 87. The repair was eating its own work queue one batch per
 * night, and the sweep printed "still failing 0" while it happened, because it
 * read result.failed and the API returns stillFailing.
 *
 * A fetch failure says something about the connection, never about the file.
 */
describe("a repair that cannot reach the file", () => {
  function docNeedingRepair() {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "d1",
          filename: "BA106 OSPM_Guide.docx",
          kind: "docx",
          status: "failed",
          status_detail: 'DOMParser.parseFromString: the provided mimeType "undefined" is not valid',
          ms_drive_item_id: "drive-1",
        },
      ],
    });
  }

  it("leaves the diagnosis alone when the download throws", async () => {
    docNeedingRepair();
    const writesBefore = mockQuery.mock.calls.length;

    await reprocessFixable(
      async () => {
        throw new Error("no_token");
      },
      { userId: "u", role: "cto" },
    );

    /* THE ASSERTION THAT WOULD HAVE SAVED THE QUEUE. Only the SELECT ran. No
       UPDATE touched the row, so it is still a docx that failed on the parser
       bug and the next run will still find it. */
    const updates = mockQuery.mock.calls
      .slice(writesBefore)
      .filter((c: unknown[]) => /^\s*UPDATE\b/i.test(String(c[0])));
    expect(updates).toHaveLength(0);
  });

  it("leaves the diagnosis alone when the download returns nothing", async () => {
    docNeedingRepair();
    const before = mockQuery.mock.calls.length;
    await reprocessFixable(async () => null, { userId: "u", role: "cto" });
    expect(
      mockQuery.mock.calls.slice(before).filter((c: unknown[]) => /^\s*UPDATE\b/i.test(String(c[0]))),
    ).toHaveLength(0);
  });

  /* Silence would be worse than the overwrite: the run has to say it failed,
     it just must not write that verdict onto the document. */
  it("still reports the failure", async () => {
    docNeedingRepair();
    const report = await reprocessFixable(
      async () => {
        throw new Error("no_token");
      },
      { userId: "u", role: "cto" },
    );
    expect(report.considered).toBe(1);
    expect(report.repaired).toBe(0);
    expect(report.stillFailing).toBe(1);
    expect(report.outcomes[0].detail).toMatch(/no_token/);
  });
});

/**
 * Finishing early beats being cut off.
 *
 * THE RUN THAT PROMPTED IT. The first repair that could actually download
 * anything indexed 22 documents in about 50 seconds and was then killed by the
 * platform's default 60-second budget. It returned a 500, so the 22 successes
 * were invisible in the report and the next run had no idea how far it got.
 *
 * The queue drains across runs either way. Only one of the two says so.
 */
describe("a repair that runs out of time", () => {
  function candidates(n: number) {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: n }, (_, i) => ({
        id: `d${i}`,
        filename: `doc-${i}.docx`,
        kind: "docx",
        status: "failed",
        status_detail: 'DOMParser.parseFromString: the provided mimeType "undefined" is not valid',
        ms_drive_item_id: `drive-${i}`,
      })),
    });
  }

  it("stops on its own clock and still returns a report", async () => {
    candidates(20);
    const report = await reprocessFixable(async () => Buffer.from("x"), { userId: "u", role: "cto" }, {
      /* Already past, so it stops before the first document. */
      deadline: Date.now() - 1,
    });
    expect(report.ranOutOfTime).toBe(true);
    expect(report.attempted).toBe(0);
    /* The count of what was WAITING survives, which is what tells the next run
       there is still work. */
    expect(report.considered).toBe(20);
  });

  it("does not claim it ran out when it finished the batch", async () => {
    candidates(2);
    const report = await reprocessFixable(async () => Buffer.from("x"), { userId: "u", role: "cto" }, {
      deadline: Date.now() + 60_000,
    });
    expect(report.ranOutOfTime).toBe(false);
    expect(report.attempted).toBe(2);
  });

  it("runs to the end when given no deadline", async () => {
    candidates(3);
    const report = await reprocessFixable(async () => Buffer.from("x"), { userId: "u", role: "cto" });
    expect(report.attempted).toBe(3);
  });
});

/**
 * One oversized file must not take a whole batch with it.
 *
 * A repair pulls the whole file into a Buffer to re-extract it. Exceeding the
 * function's memory does not raise an error a catch can see: the process dies,
 * the request returns 500, and the report never gets written, so every
 * document the run had already repaired disappears with it.
 *
 * Measured 2026-09-01. Once the small files drained, four consecutive runs
 * died almost immediately and moved the queue by one or two each. The queue
 * held a 44.7MB file and ten others over 25MB, sorted to the front. One
 * document was killing a batch of fifty.
 */
describe("files too big to pull into memory", () => {
  it("excludes them in the query, not in the loop", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findCandidates({ limit: 50 });

    const [sql, args] = mockQuery.mock.calls[0];
    /* In SQL, because a document skipped in the loop has already been
       downloaded, which is the thing that kills the process. */
    expect(String(sql)).toMatch(/size_bytes/);
    expect(args).toContain(MAX_REPAIR_BYTES);
  });

  /* Unknown is not the same fact as too big, and the download is the next
     thing that would find out either way. */
  it("lets a document with no recorded size through", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findCandidates({ limit: 50 });
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/size_bytes IS NULL OR/);
  });

  it("keeps a ceiling big enough for anything with text in it", () => {
    /* Everything above it in this corpus is video, image sets and design
       files, which would fail extraction even if they fit. */
    expect(MAX_REPAIR_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(MAX_REPAIR_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024);
  });
});
