/** @jest-environment jsdom */
/**
 * Tests for the assistant image-attachment compressor. The canvas path
 * cannot run in jsdom (no real 2d context), so we test:
 *   - the pure decision/format/scale helpers exhaustively, and
 *   - that compressImageFile degrades to a no-op (returns the original
 *     file untouched) when no canvas is available, which is the
 *     contract the caller relies on to never make things worse.
 */

import {
  isCompressibleImage,
  needsImageCompression,
  formatBytes,
  toJpegName,
  scaledDimensions,
  compressImageFile,
  IMAGE_ATTACH_MAX_DIMENSION,
} from "@/lib/assistant/image-compress";

describe("isCompressibleImage", () => {
  it("accepts raster image types", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]) {
      expect(isCompressibleImage(t)).toBe(true);
    }
  });
  it("rejects vector + icon + non-image + empty", () => {
    for (const t of [
      "image/svg+xml",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "application/pdf",
      "text/plain",
      "",
      undefined,
      null,
    ]) {
      expect(isCompressibleImage(t)).toBe(false);
    }
  });
});

describe("needsImageCompression", () => {
  it("true only for a compressible image over the cap", () => {
    expect(needsImageCompression({ type: "image/png", size: 900_000 }, 512_000)).toBe(true);
  });
  it("false for an image already under the cap", () => {
    expect(needsImageCompression({ type: "image/png", size: 100_000 }, 512_000)).toBe(false);
  });
  it("false for a large non-image (PDF is not rasterized here)", () => {
    expect(needsImageCompression({ type: "application/pdf", size: 9_000_000 }, 512_000)).toBe(false);
  });
  it("false for a large svg (never rasterized)", () => {
    expect(needsImageCompression({ type: "image/svg+xml", size: 9_000_000 }, 512_000)).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(512_000)).toBe("500 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
});

describe("toJpegName", () => {
  it("swaps the extension for .jpg, preserving the base", () => {
    expect(toJpegName("Screenshot 2026.png")).toBe("Screenshot 2026.jpg");
    expect(toJpegName("photo.jpeg")).toBe("photo.jpg");
  });
  it("appends .jpg when there is no extension", () => {
    expect(toJpegName("clipboard")).toBe("clipboard.jpg");
  });
});

describe("scaledDimensions", () => {
  it("never upscales a small image", () => {
    expect(scaledDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
  it("scales the longest edge down to the cap, preserving aspect", () => {
    expect(scaledDimensions(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
  });
  it("handles a tall image", () => {
    expect(scaledDimensions(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 });
  });
  it("is safe on a zero dimension", () => {
    expect(scaledDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });
});

describe("compressImageFile (no-canvas fallback)", () => {
  it("returns the ORIGINAL file unchanged when canvas has no 2d context (jsdom)", async () => {
    const original = new File([new Uint8Array(900_000)], "big.png", { type: "image/png" });
    const out = await compressImageFile(original, { maxBytes: 512_000 });
    // jsdom's canvas.getContext returns null, so the helper must hand
    // back the exact original rather than hang on an <img> that never
    // loads or attach an empty blob.
    expect(out).toBe(original);
  });

  it("returns non-image files untouched without touching the DOM", async () => {
    const pdf = new File([new Uint8Array(10)], "a.pdf", { type: "application/pdf" });
    const out = await compressImageFile(pdf, { maxBytes: 512_000 });
    expect(out).toBe(pdf);
  });

  it("exposes a sane default dimension", () => {
    expect(IMAGE_ATTACH_MAX_DIMENSION).toBeGreaterThanOrEqual(1024);
  });
});
