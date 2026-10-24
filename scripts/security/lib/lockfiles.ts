/**
 * Lockfile parsers: text in, exact package@version list out.
 *
 * WHY LOCKFILES AND NOT MANIFESTS. A compromised release is one exact version
 * (litellm 1.107.0, @subql/common 5.8.3). A manifest says "^5.8.2", which is
 * safe or not depending on the day it was installed. Only the lockfile says
 * what was actually resolved, so only the lockfile can answer "do we run it".
 *
 * Pure and dependency-free on purpose: no YAML or TOML library, because the
 * shapes we need (a package name and its resolved version) sit on predictable
 * lines in every format below, and a parser dependency in a supply-chain check
 * is one more package that could be the compromised one.
 *
 * Supported: package-lock.json (v1, v2, v3), pnpm-lock.yaml (v5 to v9),
 * yarn.lock (classic v1 and berry), requirements*.txt (== pins only),
 * poetry.lock, uv.lock.
 */

export type Ecosystem = "npm" | "PyPI";

export interface LockedPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export type LockfileKind = "package-lock" | "pnpm-lock" | "yarn-lock" | "requirements" | "poetry-lock" | "uv-lock";

/** Which parser a path needs, or null when it is not a lockfile we read. */
export function lockfileKind(path: string): LockfileKind | null {
  if (/(^|\/)node_modules\//.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "package-lock";
  if (base === "pnpm-lock.yaml") return "pnpm-lock";
  if (base === "yarn.lock") return "yarn-lock";
  if (/^requirements.*\.txt$/i.test(base)) return "requirements";
  if (base === "poetry.lock") return "poetry-lock";
  if (base === "uv.lock") return "uv-lock";
  return null;
}

/** A resolved version starts with a digit; git URLs, file: and link: do not. */
function isRealVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d/.test(v);
}

/** PEP 503 normalization so "Foo_Bar" and "foo-bar" are the same package. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function dedupe(list: LockedPackage[]): LockedPackage[] {
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const p of list) {
    const k = `${p.ecosystem}|${p.name}|${p.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function parsePackageLock(text: string): LockedPackage[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out: LockedPackage[] = [];
  const packages = doc.packages as Record<string, Record<string, unknown>> | undefined;
  if (packages && typeof packages === "object") {
    for (const [key, entry] of Object.entries(packages)) {
      if (!key || !entry || entry.link) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue; // workspace folders, not installed packages
      const name = typeof entry.name === "string" ? entry.name : key.slice(idx + "node_modules/".length);
      if (isRealVersion(entry.version)) out.push({ ecosystem: "npm", name, version: entry.version });
    }
    return dedupe(out);
  }
  // lockfileVersion 1: nested `dependencies`.
  const walk = (deps: unknown) => {
    if (!deps || typeof deps !== "object") return;
    for (const [name, entry] of Object.entries(deps as Record<string, Record<string, unknown>>)) {
      if (entry && isRealVersion(entry.version)) out.push({ ecosystem: "npm", name, version: entry.version });
      if (entry) walk(entry.dependencies);
    }
  };
  walk(doc.dependencies);
  return dedupe(out);
}

/**
 * Split a pnpm package key into name and version.
 *   v9:  "@scope/name@1.2.3(peer@1.0.0)"   v6: "/@scope/name@1.2.3(peer@1)"
 *   v5:  "/@scope/name/1.2.3_peer@1.0.0"
 */
export function splitPnpmKey(raw: string): { name: string; version: string } | null {
  let key = raw.trim().replace(/:$/, "").replace(/^['"]|['"]$/g, "");
  key = key.replace(/^\//, "");
  // v5 form first: name/version with an optional _peer suffix. Checked before
  // the "@" form because a v5 peer suffix ("_react@18.2.0") contains an "@".
  const v5 = /^(@[^/@]+\/[^/@]+|[^@/][^/@]*)\/(\d[^/_(]*)(?:_.*)?$/.exec(key);
  if (v5) return { name: v5[1], version: v5[2] };
  const paren = key.indexOf("(");
  if (paren > -1) key = key.slice(0, paren);
  const at = key.lastIndexOf("@");
  if (at > 0) {
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (isRealVersion(version)) return { name, version };
  }
  return null;
}

export function parsePnpmLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inSection = /^(packages|snapshots):\s*$/.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^ {2}(\S.*):\s*$/.exec(line);
    if (!m) continue;
    const parsed = splitPnpmKey(m[1]);
    if (parsed) out.push({ ecosystem: "npm", ...parsed });
  }
  return dedupe(out);
}

/** Name from one yarn descriptor: "@scope/name@^1", "name@npm:^1.0.0". */
function yarnDescriptorName(desc: string): string | null {
  const d = desc.trim().replace(/^['"]|['"]$/g, "");
  const at = d.indexOf("@", d.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  return d.slice(0, at);
}

export function parseYarnLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (/^\S/.test(line)) {
      // Header: one or more comma-separated descriptors, ending with ":".
      const header = line.replace(/:\s*$/, "");
      if (header.startsWith("__metadata")) {
        current = null;
        continue;
      }
      const first = header.split(",")[0];
      current = yarnDescriptorName(first);
      if (current && /@(workspace|patch|link|portal|file):/.test(first)) current = null;
      continue;
    }
    if (!current) continue;
    const v = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (v && isRealVersion(v[1]) && !v[1].includes("use.local")) {
      out.push({ ecosystem: "npm", name: current, version: v[1] });
      current = null;
    }
  }
  return dedupe(out);
}

export function parseRequirements(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const spec = line.split(";")[0].split(/\s+--hash/)[0].trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([^\s,]+)$/.exec(spec);
    if (m && isRealVersion(m[3])) out.push({ ecosystem: "PyPI", name: normalizePyName(m[1]), version: m[3] });
  }
  return dedupe(out);
}

/** poetry.lock and uv.lock share the shape we need: [[package]] name + version. */
export function parseTomlPackageBlocks(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  const flush = () => {
    if (name && isRealVersion(version)) out.push({ ecosystem: "PyPI", name: normalizePyName(name), version });
    name = null;
    version = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\[\[package\]\]\s*$/.test(line)) {
      flush();
      inPackage = true;
      continue;
    }
    if (/^\[/.test(line)) {
      // A sub-table ([package.dependencies]) or any other table ends the fields we read.
      if (inPackage) flush();
      inPackage = false;
      continue;
    }
    if (!inPackage) continue;
    const n = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (n && name === null) name = n[1];
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v && version === null) version = v[1];
  }
  flush();
  return dedupe(out);
}

export function parseLockfile(kind: LockfileKind, text: string): LockedPackage[] {
  switch (kind) {
    case "package-lock":
      return parsePackageLock(text);
    case "pnpm-lock":
      return parsePnpmLock(text);
    case "yarn-lock":
      return parseYarnLock(text);
    case "requirements":
      return parseRequirements(text);
    case "poetry-lock":
    case "uv-lock":
      return parseTomlPackageBlocks(text);
  }
}

/** Container image references in Dockerfiles and compose files. */
export function isImageFile(path: string): boolean {
  if (/(^|\/)node_modules\//.test(path)) return false;
  const base = path.split("/").pop() ?? "";
  return /^Dockerfile(\..+)?$/i.test(base) || /\.Dockerfile$/i.test(base) || /^(docker-)?compose(\..+)?\.ya?ml$/i.test(base);
}

export interface ImageRef {
  image: string;
  tag: string | null;
  digest: string | null;
}

/** Every `FROM x` and `image: x` reference, split into repo, tag and digest. */
export function parseImageRefs(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line) ?? /^\s*-?\s*image:\s*["']?([^"'\s#]+)/.exec(line);
    if (!m) continue;
    let ref = m[1];
    let digest: string | null = null;
    const atIdx = ref.indexOf("@sha256:");
    if (atIdx > -1) {
      digest = ref.slice(atIdx + 1);
      ref = ref.slice(0, atIdx);
    }
    const lastSlash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    let tag: string | null = null;
    if (colon > lastSlash) {
      tag = ref.slice(colon + 1);
      ref = ref.slice(0, colon);
    }
    out.push({ image: ref.toLowerCase(), tag, digest });
  }
  return out;
}
