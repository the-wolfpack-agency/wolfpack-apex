/** @jest-environment node */
/**
 * The plugin zip (directory submission + in-app download) is a valid archive
 * WordPress can install: one ogiam-forcefield/ folder holding every plugin file,
 * byte-identical to the source after inflate, CRC-32 correct, no dotfiles, and
 * deterministic (the same source always yields the same bytes).
 */
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPluginZip, crc32, pluginSourceDir, pluginVersion, PLUGIN_SLUG } from "@/lib/forcefield-web/wordpress-plugin-zip";

interface Entry { name: string; method: number; crc: number; data: Buffer }

/** A tiny independent reader: walk the central directory, inflate each entry. */
function readZip(zip: Buffer): Entry[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    out.push({ name, method, crc, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen;
  }
  return out;
}

describe("wordpress plugin zip", () => {
  const { zip, version, files } = buildPluginZip();
  const entries = readZip(zip);

  it("holds every plugin file under one ogiam-forcefield/ folder, nothing else", () => {
    expect(entries[0].name).toBe(`${PLUGIN_SLUG}/`);
    for (const e of entries) expect(e.name.startsWith(`${PLUGIN_SLUG}/`)).toBe(true);
    for (const f of ["ogiam-forcefield.php", "readme.txt", "includes/connect.php", "includes/inventory.php"]) expect(files).toContain(f);
    expect(entries.some((e) => /\/\./.test(e.name))).toBe(false);
  });

  it("each file inflates to the exact source bytes with a correct CRC-32", () => {
    for (const e of entries.slice(1)) {
      const src = readFileSync(join(pluginSourceDir(), e.name.slice(PLUGIN_SLUG.length + 1)));
      expect(e.data.equals(src)).toBe(true);
      expect(e.crc).toBe(crc32(src));
    }
  });

  it("is deterministic and carries the plugin Version", () => {
    expect(buildPluginZip().zip.equals(zip)).toBe(true);
    expect(version).toBe(pluginVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("crc32 matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
