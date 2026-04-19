/**
 * Reality-check fixture generator.
 *
 * Produces tiny, self-contained PNG wireframes used by the three
 * reality-check specs. We intentionally do NOT pull in `canvas` or any
 * image lib — per the engineering directive "no new runtime deps". The
 * PNGs are hand-rolled uncompressed image data streams the server-side
 * image extractor (Sharp / unpdf) can decode.
 *
 * Each fixture carries one bold, distinctive word the AI extractor
 * should preserve ("ACME", "RACING", "PARTNER") — if the produced brief
 * doesn't contain ANY capitalised word from the fixture, the extractor
 * is silently falling back to boilerplate (the bug we want to catch).
 *
 * Usage: called on-demand from specs, lazy-writes to disk if missing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// Tiny 5x7 bitmap font for the uppercase letters we need. Each glyph is
// a 2D array of 0/1 pixels; we stack rasterized rows into the PNG.
const GLYPHS: Record<string, number[][]> = {
  A: [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  C: [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  E: [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ],
  G: [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  I: [
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [1, 1, 1, 1, 1],
  ],
  M: [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  N: [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  P: [
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
  ],
  R: [
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
    [1, 0, 1, 0, 0],
    [1, 0, 0, 1, 0],
    [1, 0, 0, 0, 1],
  ],
  T: [
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
  ],
  " ": [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ],
};

/**
 * Render a short uppercase string into an 800x600 PNG buffer with large
 * black glyphs on a white background. Distinctive enough for vision
 * models to read back reliably.
 */
export function renderTextPng(text: string): Buffer {
  const W = 800;
  const H = 600;
  const SCALE = 16; // each glyph pixel becomes a 16×16 block
  const GLYPH_W = 5 * SCALE;
  const GLYPH_H = 7 * SCALE;
  const SPACING = SCALE; // gap between glyphs
  const rowLen = W * 3 + 1; // 3 bytes per RGB pixel + 1 filter byte

  // Start with a white canvas (each row prefixed with 0 = "no filter").
  const raw = Buffer.alloc(H * rowLen, 0xff);
  for (let y = 0; y < H; y++) raw[y * rowLen] = 0;

  const upper = text.toUpperCase();
  const textWidth = upper.length * GLYPH_W + (upper.length - 1) * SPACING;
  const startX = Math.max(0, Math.floor((W - textWidth) / 2));
  const startY = Math.floor((H - GLYPH_H) / 2);

  upper.split("").forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    const gx = startX + i * (GLYPH_W + SPACING);
    for (let py = 0; py < 7; py++) {
      for (let px = 0; px < 5; px++) {
        if (!glyph[py][px]) continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const x = gx + px * SCALE + dx;
            const y = startY + py * SCALE + dy;
            if (x < 0 || x >= W || y < 0 || y >= H) continue;
            const off = y * rowLen + 1 + x * 3;
            raw[off] = 0; // R
            raw[off + 1] = 0; // G
            raw[off + 2] = 0; // B
          }
        }
      }
    }
  });

  const compressed = zlib.deflateSync(raw);
  return buildPng(W, H, compressed);
}

function buildPng(width: number, height: number, idat: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor RGB
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Ensure the named fixture exists on disk. Returns the absolute path.
 * Safe to call every test run — idempotent, tiny files (<10 kB each
 * after zlib).
 */
export function ensureFixture(name: string, text: string): string {
  const fixturesDir = path.resolve(__dirname);
  if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
  const full = path.join(fixturesDir, name);
  if (!fs.existsSync(full)) {
    fs.writeFileSync(full, renderTextPng(text));
  }
  return full;
}
