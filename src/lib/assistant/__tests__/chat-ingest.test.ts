/**
 * Tests for chat-ingest.ts.
 *
 * The helper wraps /api/brain/ingest with structured failure codes
 * suitable for inline-in-chat surfacing. Each branch:
 *   - happy path (201) returns {ok:true, ...}
 *   - 401 → code=unauthorized
 *   - 429 → code=rate_limited + retryAfterSec parsed from header
 *   - 400/415 → code=validation/unsupported
 *   - other 5xx → code=internal
 *   - network throw → code=network
 *   - dedupe path returns duplicateOf
 *
 * formatIngestSystemMessage produces stable, Markdown-rendered chat
 * messages for each outcome.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetch(...a),
}));

import {
  ingestFileFromChat,
  formatIngestSystemMessage,
} from "@/lib/assistant/chat-ingest";

function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function fakeFile(name = "notes.pdf"): File {
  return new File(["fake-bytes"], name, { type: "application/pdf" });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("ingestFileFromChat — happy path", () => {
  test("returns {ok:true} with document_id + chunk_count from 201", async () => {
    mockFetch.mockResolvedValueOnce(
      fakeResponse(201, {
        document_id: "doc-abc",
        chunk_count: 5,
        extracted_chars: 12345,
      }),
    );
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documentId).toBe("doc-abc");
      expect(r.chunkCount).toBe(5);
      expect(r.extractedChars).toBe(12345);
      expect(r.duplicateOf).toBeUndefined();
    }
  });

  test("surfaces duplicateOf when the file matches an existing doc", async () => {
    mockFetch.mockResolvedValueOnce(
      fakeResponse(200, {
        document_id: "doc-new",
        chunk_count: 0,
        extracted_chars: 0,
        duplicate_of: "doc-original",
      }),
    );
    const r = await ingestFileFromChat(fakeFile("dup.pdf"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.duplicateOf).toBe("doc-original");
  });
});

describe("ingestFileFromChat — failure paths", () => {
  test("401 → code=unauthorized", async () => {
    mockFetch.mockResolvedValueOnce(fakeResponse(401, { error: "Unauthorized" }));
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthorized");
  });

  test("429 → code=rate_limited + retryAfterSec from header", async () => {
    mockFetch.mockResolvedValueOnce(
      fakeResponse(429, { retry_after_sec: 60 }, { "retry-after": "60" }),
    );
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rate_limited");
      expect(r.retryAfterSec).toBe(60);
    }
  });

  test("415 → code=unsupported", async () => {
    mockFetch.mockResolvedValueOnce(
      fakeResponse(415, { error: "Unsupported MIME type: image/heic" }),
    );
    const r = await ingestFileFromChat(fakeFile("photo.heic"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  test("400 → code=validation with the server's error message", async () => {
    mockFetch.mockResolvedValueOnce(
      fakeResponse(400, { error: "File exceeds 25 MB cap" }),
    );
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("validation");
      expect(r.message).toContain("25 MB cap");
    }
  });

  test("5xx → code=internal", async () => {
    mockFetch.mockResolvedValueOnce(fakeResponse(500, { error: "boom" }));
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });

  test("network throw → code=network", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("network");
      expect(r.message).toContain("connection refused");
    }
  });

  test("malformed body → code=internal", async () => {
    mockFetch.mockResolvedValueOnce(fakeResponse(201, { not_the_field: "x" }));
    const r = await ingestFileFromChat(fakeFile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

describe("formatIngestSystemMessage", () => {
  test("success → checkmark + Manage link with doc id", () => {
    const msg = formatIngestSystemMessage("notes.pdf", {
      ok: true,
      documentId: "doc-abc",
      chunkCount: 5,
      extractedChars: 1234,
    });
    expect(msg).toContain("✅");
    expect(msg).toContain("notes.pdf");
    expect(msg).toContain("doc-abc");
    expect(msg).toMatch(/\[Manage\]/);
  });

  test("duplicate → reuses existing doc + 'matched an existing' wording", () => {
    const msg = formatIngestSystemMessage("dup.pdf", {
      ok: true,
      documentId: "doc-new",
      chunkCount: 0,
      extractedChars: 0,
      duplicateOf: "doc-original",
    });
    expect(msg).toContain("matched an existing");
    expect(msg).toContain("doc-original");
  });

  test("rate_limited → ⏸ icon + message", () => {
    expect(
      formatIngestSystemMessage("x.pdf", {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "slow down",
      }),
    ).toMatch(/⏸/);
  });

  test("unsupported → 📎 + 'isn't a supported file type'", () => {
    const msg = formatIngestSystemMessage("photo.heic", {
      ok: false,
      status: 415,
      code: "unsupported",
      message: "unsupported",
    });
    expect(msg).toMatch(/📎/);
    expect(msg).toMatch(/isn't a supported/);
  });

  test("network/internal → ⚠️ icon", () => {
    const msg = formatIngestSystemMessage("x.pdf", {
      ok: false,
      status: 500,
      code: "internal",
      message: "boom",
    });
    expect(msg).toMatch(/⚠️/);
  });
});
