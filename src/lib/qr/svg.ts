/**
 * QR code SVG renderer.
 *
 * Backed by `qrcode-generator` (Kazuhiko Arase, MIT, zero runtime
 * dependencies, ~10KB) — a battle-tested port used by millions of
 * deployments. The previous in-house encoder produced invalid output
 * (some phones decoded the bitstream as a Google search query),
 * caught when a real phone scanned a code generated in production.
 *
 * Why a library and not the in-house port:
 *   - QR encoding has many edge cases (mask penalty scoring, segment
 *     splitting, version selection at boundary capacities). A subtle
 *     off-by-one in any of those produces a barcode that LOOKS like a
 *     QR (correct finder patterns, dimensions) but decodes to garbage.
 *   - The in-house port passed structural unit tests but failed the
 *     only test that matters: pointing a real camera at it.
 *   - This module exports a stable surface (`renderQrSvg`) so the
 *     swap is invisible to every caller.
 */
import qrcode from "qrcode-generator";

export interface RenderQrOpts {
  /** Output SVG side length in pixels. Default 256. */
  size?: number;
  /** Module color. Default `#000`. */
  dark?: string;
  /** Background color. Default `#fff`. */
  light?: string;
  /**
   * Error correction level.
   *   L (~7%)  — most data capacity; fine for short redirect URLs.
   *   M (~15%) — default in many libraries; balances scan reliability.
   *   Q (~25%) — survives moderate damage / partial occlusion.
   *   H (~30%) — recommended when the code will be printed at small
   *              sizes or covered with a logo.
   * We default to M because real-world QR codes are often photographed
   * at oblique angles or under poor lighting; the extra resilience is
   * worth the few extra modules.
   */
  ecc?: "L" | "M" | "Q" | "H";
}

/**
 * Render the input text as a QR code SVG string.
 *
 * The output is a complete, self-contained `<svg>` element ready to
 * embed inline or write to disk. No external font/image references;
 * pure `<rect>` modules over a background fill so it renders even
 * with strict CSP and offline.
 */
export function renderQrSvg(text: string, opts: RenderQrOpts = {}): string {
  if (!text || text.length === 0) {
    throw new Error("renderQrSvg: text must be a non-empty string");
  }
  const size = opts.size ?? 256;
  const dark = opts.dark ?? "#000";
  const light = opts.light ?? "#fff";
  const ecc = opts.ecc ?? "M";

  /* typeNumber=0 lets the library auto-pick the smallest version that
     fits the payload at the requested ECC level. */
  const qr = qrcode(0, ecc);
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cellSize = size / moduleCount;

  const rects: string[] = [];
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (qr.isDark(r, c)) {
        const x = (c * cellSize).toFixed(3);
        const y = (r * cellSize).toFixed(3);
        const w = cellSize.toFixed(3);
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="${dark}"/>`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    rects.join(""),
    `</svg>`,
  ].join("");
}
