/**
 * The installable WordPress plugin zip, built from the ONE plugin source in
 * integrations/wordpress/ogiam-forcefield/. Used by:
 *   - scripts/forcefield-wp-plugin-zip.ts (npm run forcefield:wp-plugin-zip):
 *     the zip the operator submits to the WordPress.org directory, and
 *   - GET /api/forcefield/wordpress/plugin: the download behind the signup
 *     page's WordPress install button until the directory listing is live.
 *
 * A minimal, standards-conformant zip writer (deflate, CRC-32, one folder),
 * built on node:zlib: no new dependency. Deterministic: fixed timestamps and
 * sorted entries, so the same source always yields the same bytes.
 */
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const PLUGIN_SLUG = "ogiam-forcefield";

export function pluginSourceDir(root: string = process.cwd()): string {
  return join(root, "integrations", "wordpress", PLUGIN_SLUG);
}

/** The plugin Version header from the main PHP file. */
export function pluginVersion(root: string = process.cwd()): string {
  const php = readFileSync(join(pluginSourceDir(root), `${PLUGIN_SLUG}.php`), "utf8");
  return php.match(/^\s*\*\s*Version:\s*([0-9.]+)/m)?.[1] ?? "0.0.0";
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00 in MS-DOS format (fixed, so builds are reproducible).
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export interface ZipEntry {
  /** Path inside the zip, forward slashes. A trailing "/" makes a folder. */
  name: string;
  data: Buffer;
}

/** Build a zip archive from entries. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const isDir = e.name.endsWith("/");
    const raw = isDir ? Buffer.alloc(0) : e.data;
    const deflated = isDir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 9 });
    const method = isDir ? 0 : 8;
    const crc = isDir ? 0 : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // never ship .DS_Store or dotfiles
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The plugin folder as a WordPress-installable zip (ogiam-forcefield/...). */
export function buildPluginZip(root: string = process.cwd()): { zip: Buffer; version: string; files: string[] } {
  const dir = pluginSourceDir(root);
  const files = walk(dir).map((p) => relative(dir, p).split(sep).join("/"));
  const entries: ZipEntry[] = [
    { name: `${PLUGIN_SLUG}/`, data: Buffer.alloc(0) },
    ...files.map((f) => ({ name: `${PLUGIN_SLUG}/${f}`, data: readFileSync(join(dir, f)) })),
  ];
  return { zip: buildZip(entries), version: pluginVersion(root), files };
}
