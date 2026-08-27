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
jest.mock("../chunker", () => ({
  chunkText: (t: string) => [{ content: t, token_estimate: 10 }],
}));

import { findCandidates, reprocessFixable, FIXABLE } from "../reprocess";

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

  it("survives a re-fetch that throws, and says so on the row", async () => {
    const r = await reprocessFixable(async () => { throw new Error("graph 429"); }, ACTOR);
    expect(r.stillFailing).toBe(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith("d1", "failed", expect.stringMatching(/graph 429/));
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
