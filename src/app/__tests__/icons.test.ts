/**
 * @jest-environment node
 *
 * Guards the app/browser/PWA icons that are generated from the single source
 * logo (public/ogiam-icon.png) by `npm run icons:generate`. If an icon goes
 * missing or is the wrong size, the browser tab / PWA install icon silently
 * breaks; this fails the build instead.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(__dirname, "..", "..", "..");
const p = (rel: string) => join(ROOT, rel);

describe("app icons", () => {
  it("has a valid multi-image favicon.ico", () => {
    const path = p("src/app/favicon.ico");
    expect(existsSync(path)).toBe(true);
    const ico = readFileSync(path);
    // ICO magic: reserved(0) + type(1=icon).
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    // At least one image entry.
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["src/app/icon.png", 256],
    ["src/app/apple-icon.png", 180],
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
  ])("%s is a %ipx square PNG", async (rel, size) => {
    const path = p(rel);
    expect(existsSync(path)).toBe(true);
    const meta = await sharp(path).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(size);
    expect(meta.height).toBe(size);
  });

  it("keeps the source logo the icons are derived from", () => {
    expect(existsSync(p("public/ogiam-icon.png"))).toBe(true);
  });

  it("clips icons to a circle: transparent corners (no white border), opaque center", async () => {
    const { data, info } = await sharp(p("src/app/icon.png")).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    // Corners are outside the circle -> fully transparent (the source's white square is clipped away).
    expect(alphaAt(1, 1)).toBe(0);
    expect(alphaAt(info.width - 2, 1)).toBe(0);
    // Center is the mark -> fully opaque.
    expect(alphaAt(info.width >> 1, info.height >> 1)).toBe(255);
  });
});
