/**
 * POST /api/brain/upload route — contract test for the user-driven
 * Brain upload surface (UploadToBrainWidget).
 *
 * Pattern matches src/__tests__/brain-routes.test.ts:
 *   - requireCapability + ingest + analytics mocked.
 *   - Rate limiter reset between tests via _resetRateLimitState.
 *   - Each gate asserted independently so a regression in any single
 *     gate fails its own case (not a soup of mixed conditions).
 */



const mockRequireCapability = jest.fn();
const mockIngest = jest.fn();
const mockTrackEvent = jest.fn();
const mockFindDocumentBySha = jest.fn();
/* The route runs the brain extractor on the buffer; for text-shaped
 * MIME types this returns the bytes as utf-8 by default. We mock to
 * keep the test surface deterministic (no real PDF / DOCX parser). */
const mockExtract = jest.fn();
const mockIsSyncExtractable = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: any[]) => mockRequireCapability(...args),
}));
jest.mock("@/lib/brain/ingest", () => {
  const actual = jest.requireActual("@/lib/brain/ingest");
  return {
    ...actual,
    ingest: (...args: any[]) => mockIngest(...args),
  };
});
jest.mock("@/lib/brain/extractor", () => ({
  extract: (...args: any[]) => mockExtract(...args),
  isSyncExtractable: (...args: any[]) => mockIsSyncExtractable(...args),
  classifyKind: jest.requireActual("@/lib/brain/extractor").classifyKind,
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));
jest.mock("@/lib/brain/repo", () => ({
  findDocumentBySha: (...args: any[]) => mockFindDocumentBySha(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { _resetRateLimitState } from "@/lib/brain/security";

const AUTHED = {
  ok: true as const,
  user: { id: "u1", role: "cto", name: "Test", email: "t@t.co" },
};
const UNAUTH = {
  ok: false as const,
  response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
};

function makeReq(form: FormData): NextRequest {
  return new NextRequest("http://x/api/brain/upload", {
    method: "POST",
    body: form as unknown as BodyInit,
  });
}

const validText =
  "The Wolfpack Agency platform pairs marketing strategy with proprietary AI tooling to ship measurable outcomes for dealer clients. Each engagement closes on documented metrics and a published case study.";

beforeEach(() => {
  _resetRateLimitState();
  mockRequireCapability.mockReset();
  mockIngest.mockReset();
  mockTrackEvent.mockReset();
  mockFindDocumentBySha.mockReset();
  mockExtract.mockReset();
  mockIsSyncExtractable.mockReset();
  /* Reasonable defaults: text-ish files extract to themselves. */
  mockIsSyncExtractable.mockReturnValue(true);
  mockExtract.mockImplementation(async (_kind: string, buf: Buffer) => ({
    ok: true,
    text: buf.toString("utf8"),
  }));
  mockFindDocumentBySha.mockResolvedValue(null);
});

describe("POST /api/brain/upload — auth", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValue(UNAUTH);
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([validText], "ok.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/brain/upload — gates", () => {
  beforeEach(() => mockRequireCapability.mockResolvedValue(AUTHED));

  it("400 without file", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const res = await POST(makeReq(new FormData()));
    expect(res.status).toBe(400);
  });

  it("400 + reasons on empty file", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([""], "empty.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reasons).toContain("empty_file");
  });

  it("413 with file_too_large reason on oversized file", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const big = new Uint8Array(11 * 1024 * 1024); // 11 MB
    const form = new FormData();
    form.set("file", new File([big], "big.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.reasons).toContain("file_too_large");
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("400 with disallowed_file_type for video/mp4", async () => {
    /* We have to bypass the extractor flag because mp4 isn't sync-
     * extractable in the real codebase; mock matches that. */
    mockIsSyncExtractable.mockReturnValue(false);
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([validText], "movie.mp4", { type: "video/mp4" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reasons).toContain("disallowed_file_type");
  });

  it("400 with secret reason when AWS key is in the body", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const text = `${validText}\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`;
    const form = new FormData();
    form.set("file", new File([text], "leak.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reasons).toEqual(
      expect.arrayContaining(["secret_aws_access_key"]),
    );
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("400 with pii_credit_card reason when a Luhn-valid card is present", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const text = `${validText}\nCard: 4242 4242 4242 4242`;
    const form = new FormData();
    form.set("file", new File([text], "pii.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reasons).toContain("pii_credit_card");
  });
});

describe("POST /api/brain/upload — happy path + analytics", () => {
  beforeEach(() => mockRequireCapability.mockResolvedValue(AUTHED));

  it("201 + accepted on clean text upload", async () => {
    mockIngest.mockResolvedValue({
      document_id: "doc-1",
      status: "indexed",
      chunk_count: 2,
      extracted_chars: validText.length,
    });
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([validText], "notes.md", { type: "text/markdown" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document_id).toBe("doc-1");
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "notes.md",
        contentType: "text/markdown",
        uploadedBy: "u1",
        tags: expect.arrayContaining(["upload-to-brain-widget"]),
      }),
    );
  });

  it("emits brain.upload_attempted BEFORE the filter on every POST", async () => {
    mockIngest.mockResolvedValue({
      document_id: "doc-1",
      status: "indexed",
      chunk_count: 1,
      extracted_chars: 100,
    });
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([validText], "notes.md", { type: "text/markdown" }));
    await POST(makeReq(form));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "brain.upload_attempted",
      "u1",
      "cto",
      expect.objectContaining({ mime_type: "text/markdown" }),
    );
  });

  it("emits brain.upload_accepted with document_id on success", async () => {
    mockIngest.mockResolvedValue({
      document_id: "doc-1",
      status: "indexed",
      chunk_count: 1,
      extracted_chars: 100,
    });
    const { POST } = await import("@/app/api/brain/upload/route");
    const form = new FormData();
    form.set("file", new File([validText], "notes.md", { type: "text/markdown" }));
    await POST(makeReq(form));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "brain.upload_accepted",
      "u1",
      "cto",
      expect.objectContaining({ document_id: "doc-1" }),
    );
  });

  it("emits brain.upload_rejected with the reasons array when the filter blocks", async () => {
    const { POST } = await import("@/app/api/brain/upload/route");
    const text = `${validText}\nCard: 4242 4242 4242 4242`;
    const form = new FormData();
    form.set("file", new File([text], "pii.md", { type: "text/markdown" }));
    await POST(makeReq(form));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "brain.upload_rejected",
      "u1",
      "cto",
      expect.objectContaining({
        reasons: expect.stringContaining("pii_credit_card"),
      }),
    );
  });
});
