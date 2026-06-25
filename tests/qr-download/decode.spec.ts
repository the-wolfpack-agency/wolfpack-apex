/**
 * Real-browser regression guard for QR download rasterization.
 *
 * The "svg image decode failed" bug: the source QR SVG already carries
 * `width="N" height="N"` (renderQrSvg), and the raster path APPENDED
 * another width/height, producing duplicate attributes. An <img> parses
 * SVG as strict XML, so the duplicate made it invalid and decode failed
 * in EVERY browser — PNG/JPG/PDF download all broken. jsdom cannot
 * decode SVG images or run canvas.toBlob, so this proof must run in a
 * real engine. Runs standalone (no dev server / DB / auth) via
 * playwright.qr.config.ts.
 */
import { test, expect } from "@playwright/test";
import { normalizeSvgSize, svgToEps } from "../../src/app/(dashboard)/qr/download";

// Mirrors the exact <svg> open tag renderQrSvg emits (xmlns + viewBox +
// width + height + shape-rendering), which is the bug precondition.
const SOURCE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="192" height="192" shape-rendering="crispEdges">' +
  '<rect width="192" height="192" fill="#fff"/>' +
  '<rect x="0" y="0" width="64" height="64" fill="#000"/>' +
  '<rect x="128" y="0" width="64" height="64" fill="#000"/>' +
  '<rect x="0" y="128" width="64" height="64" fill="#000"/>' +
  "</svg>";

// The pre-fix behavior, reproduced inline to assert it genuinely fails
// (so this test would have caught the regression).
const BUGGY = SOURCE_SVG.replace(
  /<svg([^>]*)>/,
  '<svg$1 width="1024" height="1024">',
);

async function rasterizeInBrowser(
  page: import("@playwright/test").Page,
  svg: string,
  mime: "image/png" | "image/jpeg",
): Promise<{ decoded: boolean; bytes: number }> {
  return page.evaluate(
    async ({ svgStr, mimeType }) => {
      const url = URL.createObjectURL(
        new Blob([svgStr], { type: "image/svg+xml" }),
      );
      try {
        const decoded = await new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = url;
        });
        if (!decoded) return { decoded: false, bytes: 0 };
        const img = await new Promise<HTMLImageElement>((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.src = url;
        });
        const c = document.createElement("canvas");
        c.width = 1024;
        c.height = 1024;
        const ctx = c.getContext("2d")!;
        if (mimeType === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, 1024, 1024);
        }
        ctx.drawImage(img, 0, 0, 1024, 1024);
        const blob = await new Promise<Blob | null>((res) =>
          c.toBlob(res, mimeType, mimeType === "image/jpeg" ? 0.95 : undefined),
        );
        return { decoded: true, bytes: blob ? blob.size : 0 };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { svgStr: svg, mimeType: mime },
  );
}

test.describe("qr download rasterization", () => {
  test("normalizeSvgSize output decodes + rasterizes to a non-empty PNG", async ({
    page,
  }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const sized = normalizeSvgSize(SOURCE_SVG, 1024);
    // exactly one width/height — no duplicates
    const tag = sized.match(/<svg[^>]*>/)![0];
    expect((tag.match(/\bwidth=/g) || []).length).toBe(1);
    expect((tag.match(/\bheight=/g) || []).length).toBe(1);

    const png = await rasterizeInBrowser(page, sized, "image/png");
    expect(png.decoded).toBe(true);
    expect(png.bytes).toBeGreaterThan(0);
  });

  test("normalizeSvgSize output rasterizes to a non-empty JPEG", async ({
    page,
  }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const jpg = await rasterizeInBrowser(
      page,
      normalizeSvgSize(SOURCE_SVG, 1024),
      "image/jpeg",
    );
    expect(jpg.decoded).toBe(true);
    expect(jpg.bytes).toBeGreaterThan(0);
  });

  test("the pre-fix duplicate-attribute SVG genuinely fails to decode", async ({
    page,
  }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const png = await rasterizeInBrowser(page, BUGGY, "image/png");
    expect(png.decoded).toBe(false);
  });

  test("EPS export yields a non-empty PostScript blob in a real browser", async ({
    page,
  }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const eps = svgToEps(SOURCE_SVG, "nick-card");
    // The actual download artifact, built the way saveBlob does, in a real engine.
    const result = await page.evaluate((epsStr) => {
      const blob = new Blob([epsStr], { type: "application/postscript" });
      return { size: blob.size, type: blob.type };
    }, eps);
    expect(result.type).toBe("application/postscript");
    expect(result.size).toBeGreaterThan(0);
    expect(eps.startsWith("%!PS-Adobe-3.0 EPSF-3.0")).toBe(true);
    // True vector: one rectfill per dark module (3 in SOURCE_SVG) + 1 background.
    expect((eps.match(/ rectfill/g) || []).length).toBe(4);
  });
});
