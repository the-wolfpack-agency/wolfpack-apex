/**
 * Known-compromised package versions in a CHANGE to a lockfile.
 *
 * When a change touches package-lock.json (or npm-shrinkwrap.json) or
 * pnpm-lock.yaml, this reads the resolved name@version entries the change ADDED
 * or CHANGED and compares them against the curated list in
 * security/known-compromised.json. A hit is critical: the gate blocks and the
 * verdict cites the advisory source from the list.
 *
 * Deterministic and offline. No network, no model. It reuses the org
 * supply-chain check's own pure helpers (scripts/security/lib), so the PR gate
 * and the scheduled org sweep share one idea of "pnpm key" and "known match".
 *
 * WHY THE DIFF AND NOT THE WHOLE FILE. A lockfile records thousands of resolved
 * versions; a PR changes a handful. Reading the added lines only means a PR is
 * held for what IT resolves, not for a pre-existing entry it did not touch (the
 * org sweep owns that). When the diff was synthesized by filesToDiff (every line
 * is "added"), every entry in the post-image is read, which is the conservative
 * reading of a whole-file change.
 *
 * A MISSING LIST IS NOT A PASS. If security/known-compromised.json cannot be
 * read, the result says so (status "list_missing") and the verdict states it.
 *
 * WHERE THE LIST COMES FROM AT RUNTIME. The default loader validates the copy
 * BUNDLED into the build by a static JSON import, not a readFileSync of the
 * checkout: a serverless deployment does not ship arbitrary repo files, so a
 * runtime file read would report "missing" on every production PR and the
 * check would never block. A deleted file therefore fails the build, which is
 * louder than any verdict line. loadKnownCompromised(root) still reads a file
 * on disk for callers that pass an explicit checkout root.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanFinding } from "@/lib/platform-scan/types";
import bundledKnownCompromised from "../../../../security/known-compromised.json";
import { splitPnpmKey, type LockedPackage } from "../../../../scripts/security/lib/lockfiles";
import { matchKnownPackages, type KnownPackage } from "../../../../scripts/security/lib/supply-chain";

export type LockfileDiffKind = "package-lock" | "pnpm-lock";

/** Which lockfile kind a path is, for the two formats this check reads. */
export function lockfileDiffKind(path: string): LockfileDiffKind | null {
  if (/(^|\/)node_modules\//.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "package-lock";
  if (base === "pnpm-lock.yaml") return "pnpm-lock";
  return null;
}

/** One file section of a unified diff: its post-image path and body lines. */
interface DiffSection {
  path: string;
  lines: string[];
}

function diffSections(diff: string): DiffSection[] {
  const out: DiffSection[] = [];
  let current: DiffSection | null = null;
  let inBody = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m ? m[2].trim() : "", lines: [] };
      out.push(current);
      inBody = false;
      continue;
    }
    if (!current) continue;
    if (!inBody) {
      const plus = /^\+\+\+ b\/(.+)$/.exec(line);
      if (plus) current.path = plus[1].trim();
      if (line.startsWith("@@")) {
        inBody = true;
        current.lines.push(line);
      }
      continue;
    }
    current.lines.push(line);
  }
  return out.filter((s) => s.path);
}

const isRealVersion = (v: string): boolean => /^\d/.test(v);

/** JSON object keys that are lockfile structure, never a package name. */
const PACKAGE_LOCK_STRUCTURAL = new Set([
  "", "packages", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "peerDependenciesMeta", "requires", "engines", "bin", "funding", "os", "cpu", "bundleDependencies",
]);

/** Resolved entries a package-lock diff adds or changes. A `"version"` line that
 *  is ADDED under a known package key is an addition or a version change. */
function packageLockAdded(lines: string[]): LockedPackage[] {
  const out: LockedPackage[] = [];
  let key: string | null = null;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      key = null; // a new hunk: the enclosing key is unknown until seen again
      continue;
    }
    const sign = raw[0];
    if (sign === "-" || sign === "\\") continue; // removed line or "\ No newline"
    const text = raw.slice(1);
    const keyMatch = /^\s*"([^"]*)":\s*\{\s*$/.exec(text);
    if (keyMatch) {
      const k = keyMatch[1];
      const idx = k.lastIndexOf("node_modules/");
      const name = idx >= 0 ? k.slice(idx + "node_modules/".length) : k;
      key = PACKAGE_LOCK_STRUCTURAL.has(name) || (idx < 0 && k.includes("/") && !k.startsWith("@")) ? null : name;
      continue;
    }
    if (sign !== "+" || !key) continue;
    const v = /^\s*"version":\s*"([^"]+)"/.exec(text);
    if (v && isRealVersion(v[1])) out.push({ ecosystem: "npm", name: key, version: v[1] });
  }
  return out;
}

/** Resolved entries a pnpm-lock diff adds or changes: added 2-space package keys
 *  in packages/snapshots (name@version is the key), plus importer dependencies
 *  whose added `version:` line now resolves to an exact version. */
function pnpmLockAdded(lines: string[]): LockedPackage[] {
  const out: LockedPackage[] = [];
  let depName: string | null = null;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      depName = null;
      continue;
    }
    const sign = raw[0];
    if (sign === "-" || sign === "\\") continue;
    const text = raw.slice(1);
    const top = /^ {2}(\S.*):\s*$/.exec(text);
    if (top) {
      depName = null;
      if (sign === "+") {
        const parsed = splitPnpmKey(top[1]);
        if (parsed) out.push({ ecosystem: "npm", ...parsed });
      }
      continue;
    }
    const dep = /^ {4,}'?(@?[^'\s:][^'\s]*?)'?:\s*$/.exec(text);
    if (dep) {
      depName = dep[1];
      continue;
    }
    if (sign !== "+" || !depName) continue;
    const v = /^\s+version:\s+'?([^'\s(]+)/.exec(text);
    if (v && isRealVersion(v[1])) out.push({ ecosystem: "npm", name: depName, version: v[1] });
  }
  return out;
}

function dedupe(list: LockedPackage[]): LockedPackage[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.name}@${p.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every lockfile path the diff touches, with the name@version entries it adds or
 *  changes. Pure. */
export function lockfileEntriesFromDiff(diff: string): { path: string; kind: LockfileDiffKind; packages: LockedPackage[] }[] {
  const out: { path: string; kind: LockfileDiffKind; packages: LockedPackage[] }[] = [];
  for (const s of diffSections(diff)) {
    const kind = lockfileDiffKind(s.path);
    if (!kind) continue;
    const packages = dedupe(kind === "package-lock" ? packageLockAdded(s.lines) : pnpmLockAdded(s.lines));
    out.push({ path: s.path, kind, packages });
  }
  return out;
}

// ---------------------------------------------------------------- curated list

export interface KnownCompromisedList {
  updated: string;
  packages: (KnownPackage & { osv?: string[] })[];
}

export type KnownCompromisedLoad =
  | { status: "loaded"; list: KnownCompromisedList }
  | { status: "missing"; reason: string };

export const KNOWN_COMPROMISED_PATH = "security/known-compromised.json";

/** Validate a parsed list. A shape that is not a list is reported as missing. */
export function validateKnownCompromised(parsed: unknown): KnownCompromisedLoad {
  const p = (parsed ?? {}) as Partial<KnownCompromisedList>;
  if (!Array.isArray(p.packages)) return { status: "missing", reason: `${KNOWN_COMPROMISED_PATH} has no packages array` };
  const packages = p.packages.filter(
    (k) => k && typeof k.name === "string" && typeof k.ecosystem === "string" && Array.isArray(k.versions) && Array.isArray(k.sources),
  );
  return { status: "loaded", list: { updated: String(p.updated ?? ""), packages } };
}

/** The list bundled into this build (the default for the PR gate). */
export function loadBundledKnownCompromised(): KnownCompromisedLoad {
  return validateKnownCompromised(bundledKnownCompromised);
}

/** Read the curated list from a checkout on disk. Never throws: an unreadable or
 *  malformed file is reported as missing with the reason. */
export function loadKnownCompromised(root: string = process.cwd()): KnownCompromisedLoad {
  try {
    return validateKnownCompromised(JSON.parse(readFileSync(join(root, KNOWN_COMPROMISED_PATH), "utf8")));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { status: "missing", reason: code === "ENOENT" ? `${KNOWN_COMPROMISED_PATH} not found` : `${KNOWN_COMPROMISED_PATH} unreadable: ${(err as Error).message.slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------- the check

export interface LockfileCompromiseResult {
  /** not_applicable: the change touches no lockfile this check reads. */
  status: "not_applicable" | "checked" | "list_missing";
  lockfiles: string[];
  /** name@version entries compared (added or changed by the change). */
  entriesChecked: number;
  findings: ScanFinding[];
  /** Set when status is list_missing. */
  reason?: string;
  /** The list's `updated` date, when it was read. */
  listUpdated?: string;
}

/**
 * Compare the lockfile entries a change adds or changes against the curated
 * list. Pure given `load` (injected in tests; defaults to reading the repo file).
 */
export function checkLockfileCompromise(
  diff: string,
  opts: { repoFullName?: string; load?: () => KnownCompromisedLoad } = {},
): LockfileCompromiseResult {
  const touched = lockfileEntriesFromDiff(diff);
  if (touched.length === 0) {
    return { status: "not_applicable", lockfiles: [], entriesChecked: 0, findings: [] };
  }
  const lockfiles = touched.map((t) => t.path);
  const entriesChecked = touched.reduce((n, t) => n + t.packages.length, 0);
  const loaded = (opts.load ?? loadBundledKnownCompromised)();
  if (loaded.status === "missing") {
    return { status: "list_missing", lockfiles, entriesChecked, findings: [], reason: loaded.reason };
  }

  const repo = opts.repoFullName ?? "change";
  const findings: ScanFinding[] = [];
  for (const t of touched) {
    for (const hit of matchKnownPackages(repo, t.path, t.packages, loaded.list.packages)) {
      const pkg = /^(.+)@([^@\s]+) \(/.exec(hit.detail);
      const entry = loaded.list.packages.find((k) => hit.detail.includes(`[${k.id}]`));
      findings.push({
        route: t.path,
        severity: "critical",
        category: "security",
        title: `Known-compromised package version in ${t.path}`,
        detail: `${hit.detail} Advisory: ${hit.source ?? "see " + KNOWN_COMPROMISED_PATH}`,
        evidence: {
          path: t.path,
          rule: "known-compromised.package",
          package: pkg ? pkg[1] : null,
          version: pkg ? pkg[2] : null,
          advisory_id: entry?.id ?? null,
          osv: entry?.osv?.join(",") ?? null,
          source: hit.source ?? null,
        },
      });
    }
  }
  return { status: "checked", lockfiles, entriesChecked, findings, listUpdated: loaded.list.updated };
}
