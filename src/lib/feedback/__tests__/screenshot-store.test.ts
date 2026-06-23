/**
 * screenshot-store: pure validators plus the two DB-backed helpers.
 *
 * The module has three layers:
 *   1. Pure helpers (stripDataUrlPrefix, base64ByteLength, validateScreenshot)
 *      that decide what is and is not a storable image. These are the trust
 *      boundary: a client check never counts.
 *   2. storeFeedbackScreenshot: WRITES one upsert via `writeQuery` and FIRES
 *      `assistant.feedback_screenshot_stored`. Both are mocked here.
 *   3. getFeedbackScreenshot: READS one row via `query` and maps it.
 *
 * Security cases that matter most: SVG and PDF are rejected (no inline-script
 * vector), oversized images are rejected, and non-base64 garbage is rejected
 * so the read endpoint never has to decode junk.
 */

const mockWriteQuery = jest.fn();
const mockQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  ALLOWED_SCREENSHOT_TYPES,
  MAX_SCREENSHOT_BYTES,
  stripDataUrlPrefix,
  base64ByteLength,
  validateScreenshot,
  storeFeedbackScreenshot,
  getFeedbackScreenshot,
} from "@/lib/feedback/screenshot-store";

/** A tiny but genuinely valid base64 JPEG-ish payload. The bytes do not have
 *  to be a real JPEG (the validator checks type + base64 + size, not magic
 *  numbers); we just need a non-empty, well-formed base64 string. */
const VALID_JPEG_B64 = Buffer.from("hello-screenshot-bytes").toString("base64");

beforeEach(() => {
  mockWriteQuery.mockReset();
  mockQuery.mockReset();
  mockTrackEvent.mockReset();
});

describe("stripDataUrlPrefix", () => {
  test("strips a data:<type>;base64, prefix and returns raw base64", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAAA")).toBe("AAAA");
  });

  test("passes a bare base64 string through untouched", () => {
    expect(stripDataUrlPrefix("AAAA")).toBe("AAAA");
  });

  test("does not treat a non-data string with a comma as a prefix", () => {
    // No "data:" sentinel, so the comma must not trigger a slice.
    expect(stripDataUrlPrefix("AB,CD")).toBe("AB,CD");
  });
});

describe("base64ByteLength", () => {
  test("computes the decoded length for unpadded input (AAAA -> 3)", () => {
    expect(base64ByteLength("AAAA")).toBe(3);
  });

  test("accounts for one padding char (AAA= -> 2)", () => {
    expect(base64ByteLength("AAA=")).toBe(2);
  });

  test("accounts for two padding chars (AA== -> 1)", () => {
    expect(base64ByteLength("AA==")).toBe(1);
  });

  test("ignores embedded whitespace and returns 0 for empty", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("   ")).toBe(0);
    expect(base64ByteLength("AA AA")).toBe(3);
  });

  test("agrees with Buffer.byteLength for a known string", () => {
    const decoded = Buffer.from(VALID_JPEG_B64, "base64");
    expect(base64ByteLength(VALID_JPEG_B64)).toBe(decoded.length);
  });
});

describe("validateScreenshot", () => {
  test("accepts a valid raster image and returns cleaned base64 + true size", () => {
    const out = validateScreenshot({
      content_type: "image/jpeg",
      data_base64: VALID_JPEG_B64,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.dataBase64).toBe(VALID_JPEG_B64);
    expect(out.byteSize).toBe(Buffer.from(VALID_JPEG_B64, "base64").length);
  });

  test("accepts every type in ALLOWED_SCREENSHOT_TYPES", () => {
    for (const t of ALLOWED_SCREENSHOT_TYPES) {
      const out = validateScreenshot({ content_type: t, data_base64: VALID_JPEG_B64 });
      expect(out.ok).toBe(true);
    }
  });

  test("rejects SVG as unsupported_type (no inline-script vector)", () => {
    const out = validateScreenshot({
      content_type: "image/svg+xml",
      data_base64: VALID_JPEG_B64,
    });
    expect(out).toEqual({ ok: false, reason: "unsupported_type" });
  });

  test("rejects application/pdf as unsupported_type", () => {
    const out = validateScreenshot({
      content_type: "application/pdf",
      data_base64: VALID_JPEG_B64,
    });
    expect(out).toEqual({ ok: false, reason: "unsupported_type" });
  });

  test("rejects empty / whitespace-only base64 as empty", () => {
    expect(validateScreenshot({ content_type: "image/png", data_base64: "" })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      validateScreenshot({ content_type: "image/png", data_base64: "   " }),
    ).toEqual({ ok: false, reason: "empty" });
  });

  test("rejects non-base64 garbage as not_base64", () => {
    expect(
      validateScreenshot({ content_type: "image/png", data_base64: "!!!notbase64!!!" }),
    ).toEqual({ ok: false, reason: "not_base64" });
  });

  test("rejects an image whose decoded size exceeds MAX_SCREENSHOT_BYTES", () => {
    /* Build a base64 string that decodes to more than the cap. base64 length
       is ceil(bytes/3)*4, so we need > MAX_SCREENSHOT_BYTES decoded bytes.
       "A" repeated is valid base64 in 4-char groups. */
    const groups = Math.ceil((MAX_SCREENSHOT_BYTES + 100) / 3);
    const tooBig = "A".repeat(groups * 4);
    const out = validateScreenshot({ content_type: "image/png", data_base64: tooBig });
    expect(out).toEqual({ ok: false, reason: "too_large" });
  });

  test("strips a data-url prefix before validating", () => {
    const out = validateScreenshot({
      content_type: "image/png",
      data_base64: `data:image/png;base64,${VALID_JPEG_B64}`,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.dataBase64).toBe(VALID_JPEG_B64);
  });

  test("rejects a non-object input as missing", () => {
    expect(validateScreenshot(null)).toEqual({ ok: false, reason: "missing" });
    expect(validateScreenshot("nope")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("storeFeedbackScreenshot", () => {
  test("upserts the cleaned base64 + derived byteSize with expectRows:0 and fires analytics", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await storeFeedbackScreenshot(
      "fb-1",
      { contentType: "image/jpeg", dataBase64: VALID_JPEG_B64 },
      { userId: "u-1", userRole: "cto" },
    );

    const expectedSize = Buffer.from(VALID_JPEG_B64, "base64").length;
    expect(out).toEqual({ byteSize: expectedSize });

    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO instinct_feedback_screenshot/);
    expect(String(sql)).toMatch(/ON CONFLICT \(feedback_id\) DO UPDATE/);
    expect(params).toEqual(["fb-1", "image/jpeg", VALID_JPEG_B64, expectedSize]);
    expect(opts).toEqual({ expectRows: 0 });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_screenshot_stored",
      "u-1",
      "cto",
      expect.objectContaining({
        feedback_id: "fb-1",
        byte_size: expectedSize,
        content_type: "image/jpeg",
      }),
    );
  });

  test("strips a data-url prefix before persisting (stored base64 is bare)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await storeFeedbackScreenshot("fb-2", {
      contentType: "image/png",
      dataBase64: `data:image/png;base64,${VALID_JPEG_B64}`,
    });
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params[2]).toBe(VALID_JPEG_B64);
  });

  test("falls back to system/unknown actor when no ctx is given", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await storeFeedbackScreenshot("fb-3", {
      contentType: "image/png",
      dataBase64: VALID_JPEG_B64,
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_screenshot_stored",
      "system",
      "unknown",
      expect.any(Object),
    );
  });

  test("throws invalid_screenshot:<reason> for a bad image and never writes", async () => {
    await expect(
      storeFeedbackScreenshot("fb-4", {
        contentType: "image/svg+xml",
        dataBase64: VALID_JPEG_B64,
      }),
    ).rejects.toThrow("invalid_screenshot:unsupported_type");
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("propagates a writeQuery failure and does NOT fire analytics", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(
      storeFeedbackScreenshot("fb-5", {
        contentType: "image/png",
        dataBase64: VALID_JPEG_B64,
      }),
    ).rejects.toThrow(/db down/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("getFeedbackScreenshot", () => {
  test("maps a stored row to the StoredScreenshot shape", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { content_type: "image/png", data_base64: VALID_JPEG_B64, byte_size: "42" },
      ],
    });
    const out = await getFeedbackScreenshot("fb-9");
    expect(out).toEqual({
      contentType: "image/png",
      dataBase64: VALID_JPEG_B64,
      byteSize: 42,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/FROM instinct_feedback_screenshot/);
    expect(params).toEqual(["fb-9"]);
  });

  test("returns null when no row exists for the feedback id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getFeedbackScreenshot("missing")).toBeNull();
  });
});
