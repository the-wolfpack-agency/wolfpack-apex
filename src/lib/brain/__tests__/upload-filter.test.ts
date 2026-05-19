/**
 * upload-filter.test.ts — every gate has at least one passing and one
 * failing fixture so a future change that weakens the filter is caught.
 *
 * The dedup gate's DB lookup is mocked (we test the contract that the
 * filter consults findDocumentBySha + handles its outcomes — not the
 * lookup itself, which has its own brain/repo coverage).
 */

const mockFindDocumentBySha = jest.fn();

jest.mock("@/lib/brain/repo", () => ({
  findDocumentBySha: (...a: unknown[]) => mockFindDocumentBySha(...a),
}));

import {
  luhnValid,
  isLowSignalRepetitive,
  normalizeText,
  resolveMimeType,
  runUploadFilter,
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
  UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
} from "@/lib/brain/upload-filter";

const validText =
  "The Wolfpack Agency platform pairs marketing strategy with proprietary AI tooling to ship measurable outcomes for dealer clients. Each engagement closes on documented metrics and a published case study.";

beforeEach(() => {
  mockFindDocumentBySha.mockReset();
  mockFindDocumentBySha.mockResolvedValue(null);
});

describe("upload-filter — pure helpers", () => {
  test("luhnValid accepts known-good test card numbers", () => {
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("5555-5555-5555-4444")).toBe(true);
    expect(luhnValid("378282246310005")).toBe(true);
  });

  test("luhnValid rejects bad checksums + non-digit garbage", () => {
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("123")).toBe(false);
    expect(luhnValid("abcd")).toBe(false);
  });

  test("isLowSignalRepetitive flags top-3 word dominance", () => {
    /* 60 tokens, "test" repeated 40 times — top-1 alone is >50%. */
    const repetitive = Array(40).fill("test").concat(Array(20).fill("foo")).join(" ");
    expect(isLowSignalRepetitive(repetitive)).toBe(true);
  });

  test("isLowSignalRepetitive accepts diverse text", () => {
    expect(isLowSignalRepetitive(validText.repeat(2))).toBe(false);
  });

  test("normalizeText collapses whitespace + trims", () => {
    expect(normalizeText("  hello\nworld\t\t  ")).toBe("hello world");
  });

  test("resolveMimeType falls back to extension when declared is octet-stream", () => {
    expect(resolveMimeType("notes.md", "application/octet-stream")).toBe(
      "text/markdown",
    );
    expect(resolveMimeType("notes.pdf", "application/pdf")).toBe("application/pdf");
    expect(resolveMimeType("video.mp4", "video/mp4")).toBe("video/mp4");
  });
});

describe("Gate 1 — MIME allowlist", () => {
  test("rejects video/mp4 even when sized ok", async () => {
    const res = await runUploadFilter({
      filename: "movie.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("disallowed_file_type");
  });

  test.each(UPLOAD_FILTER_ALLOWED_MIME_TYPES)("accepts %s", async (mime) => {
    const res = await runUploadFilter({
      filename: `file.${mime.split("/").pop()}`,
      mimeType: mime,
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    /* PII / secret / dedup are independent — what we care about is that
     * the MIME gate alone doesn't fail. */
    if (!res.ok) {
      expect(res.reasons).not.toContain("disallowed_file_type");
    }
  });
});

describe("Gate 2 — size cap", () => {
  test("rejects file > 10 MB", async () => {
    const oversized = Buffer.alloc(UPLOAD_FILTER_MAX_FILE_SIZE_BYTES + 1);
    const res = await runUploadFilter({
      filename: "huge.txt",
      mimeType: "text/plain",
      buffer: oversized,
      extractedText: validText,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("file_too_large");
  });

  test("rejects empty buffer", async () => {
    const res = await runUploadFilter({
      filename: "empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(0),
      extractedText: "",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("empty_file");
  });

  test("accepts a normal-sized file", async () => {
    const res = await runUploadFilter({
      filename: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(true);
  });
});

describe("Gate 3 — minimum content", () => {
  test("rejects 10-char content", async () => {
    const tiny = "hi there.";
    const res = await runUploadFilter({
      filename: "short.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(tiny),
      extractedText: tiny,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("insufficient_content");
  });

  test("rejects content with too few tokens", async () => {
    /* 100 chars of one repeated word fails token count (1 unique token,
     * <10 tokens after dedup… wait — we count occurrences, not uniques.
     * Use a single long word that's >50 chars but <10 tokens. */
    const fewTokens = "a".repeat(60);
    const res = await runUploadFilter({
      filename: "monoglyph.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(fewTokens),
      extractedText: fewTokens,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("insufficient_content");
  });

  test("accepts ≥50 chars + ≥10 tokens", async () => {
    const res = await runUploadFilter({
      filename: "ok.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(true);
  });
});

describe("Gate 4 — secret scan", () => {
  test.each([
    ["AKIAIOSFODNN7EXAMPLE", "secret_aws_access_key"],
    ["AIzaSyD-1234567890abcdefghijklmnopqrstuv", "secret_google_api_key"],
    [`sk_live_${"a".repeat(30)}`, "secret_stripe_live_key"],
    ["sk-ant-abc123_def456ghi789jkl", "secret_anthropic_key"],
    [`sk-${"X".repeat(40)}`, "secret_openai_key"],
    [
      `eyJabcdefghijklmnopqrstuvwxyz.eyJabcdefghijklmnopqrstuv12.AAAAAA-BBBB`,
      "secret_jwt_token",
    ],
  ])("rejects content containing a secret (%s)", async (secret, reason) => {
    const text = `${validText}\nKey: ${secret}`;
    const res = await runUploadFilter({
      filename: "leak.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
      extractedText: text,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain(reason);
  });

  test("accepts clean content", async () => {
    const res = await runUploadFilter({
      filename: "clean.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(true);
  });
});

describe("Gate 5 — PII", () => {
  test("hard-blocks SSN", async () => {
    const text = `${validText}\nSSN: 123-45-6789`;
    const res = await runUploadFilter({
      filename: "pii.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
      extractedText: text,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("pii_ssn");
  });

  test("hard-blocks Luhn-valid credit card", async () => {
    const text = `${validText}\nCard: 4242 4242 4242 4242`;
    const res = await runUploadFilter({
      filename: "card.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
      extractedText: text,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("pii_credit_card");
  });

  test("warns but does NOT block on email+phone proximity (contact card)", async () => {
    const text = `${validText}\nReach Nick at homyk@thewolfpack.agency or 555-123-4567.`;
    const res = await runUploadFilter({
      filename: "contact.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
      extractedText: text,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings).toContain("contact_card_pii");
  });

  test("scanPII=false suppresses the gate", async () => {
    const text = `${validText}\nSSN: 123-45-6789`;
    const res = await runUploadFilter({
      filename: "pii.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
      extractedText: text,
      scanPII: false,
    });
    expect(res.ok).toBe(true);
  });
});

describe("Gate 6 — dedup", () => {
  test("rejects when findDocumentBySha returns an existing row", async () => {
    mockFindDocumentBySha.mockResolvedValue({
      id: "doc-1",
      sha256: "abc",
    });
    const res = await runUploadFilter({
      filename: "dup.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("duplicate_content");
    expect(mockFindDocumentBySha).toHaveBeenCalled();
  });

  test("transient DB failure downgrades to a warning, not a rejection", async () => {
    mockFindDocumentBySha.mockRejectedValue(new Error("conn refused"));
    const res = await runUploadFilter({
      filename: "ok.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings).toContain("dedup_lookup_unavailable");
  });

  test("skipDedup=true bypasses the DB lookup entirely", async () => {
    mockFindDocumentBySha.mockResolvedValue({ id: "doc-1", sha256: "abc" });
    const res = await runUploadFilter({
      filename: "ok.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
      skipDedup: true,
    });
    expect(res.ok).toBe(true);
    expect(mockFindDocumentBySha).not.toHaveBeenCalled();
  });
});

describe("Gate 7 — repetition / low-signal", () => {
  test("rejects 'test test test ...' upload", async () => {
    const repetitive = Array(60).fill("test").join(" ");
    const res = await runUploadFilter({
      filename: "spam.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(repetitive),
      extractedText: repetitive,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("low_signal_repetitive");
  });

  test("accepts diverse-vocabulary content", async () => {
    const res = await runUploadFilter({
      filename: "ok.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(validText),
      extractedText: validText,
    });
    expect(res.ok).toBe(true);
  });
});

describe("multi-gate rejections accumulate", () => {
  test("oversized + disallowed-MIME both surface in reasons", async () => {
    const res = await runUploadFilter({
      filename: "movie.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(UPLOAD_FILTER_MAX_FILE_SIZE_BYTES + 1),
      extractedText: validText,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasons).toEqual(
        expect.arrayContaining(["disallowed_file_type", "file_too_large"]),
      );
    }
  });
});

describe("contentHash + normalizedText", () => {
  test("identical content with different whitespace yields the same hash", async () => {
    const a = await runUploadFilter({
      filename: "a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`${validText}\n\nextra`),
      extractedText: `${validText}\n\nextra`,
    });
    const b = await runUploadFilter({
      filename: "b.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`${validText} extra`),
      extractedText: `${validText} extra`,
    });
    if (a.ok && b.ok) {
      expect(a.contentHash).toBe(b.contentHash);
    } else {
      throw new Error("expected both to pass");
    }
  });
});
