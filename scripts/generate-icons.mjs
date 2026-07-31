/**
 * generate-icons.mjs: regenerate every app/browser/PWA icon from the ONE source
 * logo (public/ogiam-icon.png, the OGIAM mark shown in the app header).
 *
 * Single source of truth: change the logo once, run this, and the browser tab
 * favicon, the high-res PNG icon, the Apple touch icon, and the PWA manifest
 * icons are all regenerated consistently. Uses sharp (already a dependency); no
 * new tooling.
 *
 * Usage: npm run icons:generate
 *
 * Outputs (all derived from SRC):
 *   src/app/favicon.ico        multi-size PNG-in-ICO (16/32/48) for the tab
 *   src/app/icon.png           256px PNG, auto-linked by Next for modern browsers
 *   src/app/apple-icon.png     180px PNG, auto-linked for iOS home screen
 *   public/icons/icon-192.png  PWA manifest icon
 *   public/icons/icon-512.png  PWA manifest icon
 */
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public/ogiam-icon.png");

/** Circular alpha mask at `size` (white disc on transparent). */
const circleMask = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );

/** Square RGBA PNG at `size`, clipped to a circle. The source is a dark disc on
 *  an OPAQUE WHITE square; clipping makes the corners transparent so there is no
 *  white border in the browser tab. Force RGBA (ensureAlpha + non-palette):
 *  Turbopack's ICO decoder rejects palette/RGB PNGs embedded in the .ico. */
const png = (size) =>
  sharp(SRC)
    .resize(size, size, { fit: "cover" })
    .ensureAlpha()
    .composite([{ input: circleMask(size), blend: "dest-in" }])
    .png({ palette: false })
    .toBuffer();

/** Wrap PNG buffers into a valid multi-image ICO (PNG-in-ICO; supported by all
 *  modern browsers). Header + one 16-byte directory entry per image + PNG data. */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const dir = entries.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8); // image byte size
    e.writeUInt32LE(offset, 12); // offset from file start
    offset += buf.length;
    return e;
  });

  return Buffer.concat([header, ...dir, ...entries.map((x) => x.buf)]);
}

async function main() {
  mkdirSync(join(ROOT, "public/icons"), { recursive: true });

  // Browser tab: multi-size ICO + a crisp PNG for modern browsers.
  const icoSizes = [16, 32, 48];
  const icoBufs = await Promise.all(icoSizes.map(png));
  writeFileSync(
    join(ROOT, "src/app/favicon.ico"),
    buildIco(icoSizes.map((size, i) => ({ size, buf: icoBufs[i] }))),
  );
  writeFileSync(join(ROOT, "src/app/icon.png"), await png(256));
  writeFileSync(join(ROOT, "src/app/apple-icon.png"), await png(180));

  // PWA manifest icons (paths already referenced by public/manifest.json).
  writeFileSync(join(ROOT, "public/icons/icon-192.png"), await png(192));
  writeFileSync(join(ROOT, "public/icons/icon-512.png"), await png(512));

  console.log("[icons] regenerated favicon.ico, icon.png, apple-icon.png, icon-192, icon-512 from", "public/ogiam-icon.png");
}

main().catch((err) => {
  console.error("[icons] failed:", err);
  process.exit(1);
});
