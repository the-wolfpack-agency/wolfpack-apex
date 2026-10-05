/**
 * Phantom-dependency detection.
 *
 * Found by dogfooding the factory against apex: the author hallucinated
 * `import { parseCookies } from "nookies"` - a package NOT in package.json - so
 * the change compiled locally in the model's "head" but always fails CI
 * ("Cannot find module 'nookies'"). This is a hallucination SIGNATURE, and it is
 * deterministically detectable: an import of a bare package that is neither
 * installed (a package.json dependency) nor a Node builtin nor a path alias.
 *
 * Pure and dependency-free: parsers take strings, so the detector is fully unit
 * tested without a repo. The pipeline threads in the installed-dependency set
 * (from package.json) and feeds any phantom back to the authoring retry - the
 * same "tell the model exactly what was wrong" loop the syntax check uses.
 */

/** Node core modules (both bare and `node:`-prefixed forms resolve to these). */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** True for a specifier that is NOT an external package: a relative import
 *  (./ ../), a path alias (@/ ~/), or an absolute path. These never need a
 *  package.json entry. */
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/");
}

/** The installable package root of a specifier: `@scope/pkg/sub` -> `@scope/pkg`,
 *  `pkg/sub/deep` -> `pkg`, `node:fs` -> `fs`. Pure. */
export function packageRoot(spec: string): string {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  const parts = bare.split("/");
  if (bare.startsWith("@")) return parts.slice(0, 2).join("/"); // scoped: keep @scope/pkg
  return parts[0];
}

/** Every bare (external-package) module specifier imported/required by a source
 *  string. Excludes relative/alias/absolute imports. Deduped, order-preserved.
 *  Pure - matches static `import`/`export ... from`, bare `import "x"`, dynamic
 *  `import("x")`, and `require("x")`. */
export function extractBareImports(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (spec: string | undefined) => {
    if (!spec || isLocalSpecifier(spec)) return;
    if (!seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  };
  // import ... from "x"  |  export ... from "x"  |  import "x"
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  // import("x")  |  require("x")
  const dynRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, sideEffectRe, dynRe]) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) add(m[1]);
  }
  return out;
}

/** Parse the set of installed package roots from a package.json string: the keys
 *  of dependencies + devDependencies + peerDependencies + optionalDependencies.
 *  Returns an empty set on malformed JSON (fail-open: never throw, never
 *  false-flag from a parse error). Pure. */
export function parseInstalledRoots(packageJsonText: string): Set<string> {
  const roots = new Set<string>();
  try {
    const pkg = JSON.parse(packageJsonText) as Record<string, Record<string, string> | undefined>;
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[section];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) roots.add(name);
    }
  } catch {
    /* malformed package.json -> empty set (caller treats "unknown deps" as no-check) */
  }
  return roots;
}

export interface PhantomImport {
  path: string;
  module: string;
}

/**
 * Find imports of packages that are neither installed nor Node builtins - the
 * phantom-dependency hallucination. `installedRoots` is the set from
 * parseInstalledRoots(); when it is EMPTY the detector returns nothing (we cannot
 * know what is installed, so we do not false-flag - fail-open). Pure.
 */
export function findPhantomImports(
  files: readonly { path: string; content: string }[],
  installedRoots: ReadonlySet<string>,
): PhantomImport[] {
  if (installedRoots.size === 0) return [];
  const phantoms: PhantomImport[] = [];
  for (const file of files) {
    for (const spec of extractBareImports(file.content)) {
      const root = packageRoot(spec);
      if (NODE_BUILTINS.has(root)) continue;
      if (spec.startsWith("node:") && NODE_BUILTINS.has(root)) continue;
      if (!installedRoots.has(root)) phantoms.push({ path: file.path, module: root });
    }
  }
  return phantoms;
}

/** Feedback line for the authoring retry: name the phantom imports so the model
 *  removes them or uses an installed package instead. Pure. */
export function phantomImportFeedback(phantoms: readonly PhantomImport[]): string {
  const mods = [...new Set(phantoms.map((p) => p.module))].join(", ");
  return `The previous attempt imported package(s) that are NOT in package.json and will fail CI ("Cannot find module"): ${mods}. Do NOT import a package that is not already a dependency - use an installed package or a Node builtin (fs, path, crypto, ...), or implement it without the import.`;
}

/* ========================================================================
 * Local-import validation: a REAL module, a name that isn't there.
 *
 * findPhantomImports only sees bare external packages. The gap that shipped
 * a red WWP PR (#229): the author imported `listAllGuests` from a real local
 * module that does not export it, `recordEvent` from the WRONG local module,
 * and a `@/lib/test-helpers` alias that does not resolve to any file. All three
 * are alias/relative specifiers, which extractBareImports deliberately skips,
 * so the phantom gate never looked. tsc/CI catches them ("has no exported
 * member" / "Cannot find module"); this makes the gate catch them first.
 *
 * Deterministic + fail-OPEN: parsers are pure strings (unit-tested without a
 * repo); the pipeline supplies module contents via a resolver. When a target
 * module's content is unknown, or it re-exports with `export *`, we do NOT
 * flag a name (we cannot prove absence) - only a module that resolves to no
 * file at all, and a name provably absent from a module we can read, are flagged.
 * ====================================================================== */

export interface LocalImport {
  /** The importing file. */
  path: string;
  /** The specifier as written, e.g. "@/lib/admin/analytics" or "../x". */
  spec: string;
  /** Named members imported, as the ORIGINAL exported name (before any `as`). */
  names: string[];
  /** `import X from "..."` present. */
  hasDefault: boolean;
  /** `import * as ns from "..."` present - names unknowable, not checked. */
  hasNamespace: boolean;
}

/** Parse LOCAL (relative or `@/`,`~/` alias) imports and the named members each
 *  pulls. Bare-package imports are ignored (findPhantomImports covers those).
 *  Matches static `import`/`export … from`; side-effect `import "x"` carries no
 *  names. Pure. */
export function extractLocalImports(path: string, content: string): LocalImport[] {
  const out: LocalImport[] = [];
  const re = /\b(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const clause = m[1];
    const spec = m[2];
    if (!isLocalSpecifier(spec)) continue;
    const names: string[] = [];
    let hasDefault = false;
    let hasNamespace = false;
    // Namespace: `* as ns`
    if (/\*\s+as\s+[A-Za-z_$][\w$]*/.test(clause)) hasNamespace = true;
    // Named block: `{ a, b as c, type D }`
    const brace = clause.match(/\{([\s\S]*?)\}/);
    if (brace) {
      for (const raw of brace[1].split(",")) {
        const part = raw.trim();
        if (!part) continue;
        // drop a leading `type`/`typeof` modifier, keep the imported (pre-`as`) name
        const name = part.replace(/^type\s+/, "").replace(/^typeof\s+/, "").split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
      }
    }
    // Default: a bare identifier in the clause OUTSIDE the brace block, not `* as`.
    const outside = (brace ? clause.slice(0, brace.index) : clause).replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "");
    if (/(^|,)\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(outside) && /[A-Za-z_$]/.test(outside)) hasDefault = true;
    out.push({ path, spec, names, hasDefault, hasNamespace });
  }
  return out;
}

export interface ModuleExports {
  names: Set<string>;
  /** `export * from "…"` present - the module re-exports unknown names. */
  hasWildcard: boolean;
  hasDefault: boolean;
}

/** The set of names a module exports: declarations, `export { … }` (the name
 *  AFTER `as`), default, and a wildcard flag for `export *`. Pure. */
export function extractExportedNames(content: string): ModuleExports {
  const names = new Set<string>();
  let hasWildcard = false;
  let hasDefault = false;

  // export [default] (async) function|class|const|let|var|interface|type|enum NAME
  const declRe = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) names.add(m[1]);

  // export { a, b as c, type D as E }  -> exported name is AFTER `as` (or the bare name)
  const braceRe = /\bexport\s*\{([\s\S]*?)\}(?!\s*from\s*['"][^'"]*['"]\s*;?\s*\n?)?/g;
  // handle both `export { … }` and `export { … } from "x"` the same (names are explicit either way)
  const anyBrace = /\bexport\s*\{([\s\S]*?)\}/g;
  while ((m = anyBrace.exec(content)) !== null) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const seg = part.replace(/^type\s+/, "");
      const name = (seg.includes(" as ") ? seg.split(/\s+as\s+/)[1] : seg).trim();
      if (name === "default") { hasDefault = true; continue; }
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  void braceRe;

  if (/\bexport\s+default\b/.test(content)) hasDefault = true;
  if (/\bexport\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*['"][^'"]+['"]/.test(content)) {
    // `export * from` re-exports unknown names; `export * as ns from` is a named ns (add it)
    const nsm = content.match(/\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from/);
    if (nsm) names.add(nsm[1]); else hasWildcard = true;
  }
  return { names, hasWildcard, hasDefault };
}

/** `@/*` -> `src/` style map from a tsconfig's compilerOptions.paths. Strips a
 *  trailing `/*` and a leading `./`. Tolerates JSONC comments; {} on error. Pure. */
export function parseAliasMap(tsconfigText: string): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const stripped = tsconfigText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const cfg = JSON.parse(stripped) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const paths = cfg.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const from = alias.replace(/\*$/, "");
      const to = String(targets[0]).replace(/^\.\//, "").replace(/\*$/, "");
      map[from] = to;
    }
  } catch {
    /* malformed/absent tsconfig -> no alias map (relative imports still resolve) */
  }
  return map;
}

/** Candidate repo paths a local specifier could resolve to, best first. Pure.
 *  `fromPath` is the importing file's repo path; `aliasMap` from parseAliasMap. */
export function resolveLocalCandidates(fromPath: string, spec: string, aliasMap: Record<string, string>): string[] {
  let base: string;
  if (spec.startsWith(".")) {
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    const segs = (dir ? dir.split("/") : []).concat(spec.split("/"));
    const stack: string[] = [];
    for (const s of segs) {
      if (s === "" || s === ".") continue;
      if (s === "..") stack.pop();
      else stack.push(s);
    }
    base = stack.join("/");
  } else {
    // alias: longest matching prefix wins
    const pref = Object.keys(aliasMap).filter((p) => spec.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (pref) {
      base = (aliasMap[pref] + spec.slice(pref.length)).replace(/^\.\//, "");
    } else if (spec.startsWith("@/")) {
      // FAIL-SAFE: @/ -> src/ is the near-universal Next.js/TS convention. When the
      // alias map is unavailable at runtime (e.g. the tsconfig fetch failed), resolve
      // @/ imports anyway instead of flagging EVERY real import as missing - the
      // false positive that held build-api on broken-imports (found by the benchmark).
      base = ("src/" + spec.slice(2)).replace(/^\.\//, "");
    } else {
      return []; // a bare package (react, ...) or an unknown alias - not a local module
    }
  }
  if (/\.(tsx?|jsx?|mjs|cjs|json)$/.test(base)) return [base];
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".d.ts"];
  const out: string[] = [];
  for (const e of exts) out.push(base + e);
  for (const e of exts) out.push(`${base}/index${e}`);
  return out;
}

export interface BrokenLocalImport {
  path: string;
  spec: string;
  kind: "missing_module" | "missing_export";
  name?: string;
  /** For a missing_export: the import spec where the symbol ACTUALLY lives, if we
   *  could locate it in the repo (so the repair tells the model where to import from). */
  hint?: string;
}

/** camelCase / PascalCase -> kebab-case (requireCapability -> require-capability). */
function toKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

/**
 * Locate the import spec that actually EXPORTS `name`, by the strong naming
 * convention that a symbol lives in a file of the same name (requireCapability ->
 * .../require-capability.ts). Pure: searches the repo tree by basename, prefers a
 * `src/` path, and returns an `@/`-style spec (or null when nothing matches).
 *
 * This turns the repair feedback from "X is not here" into "X is exported from
 * <spec> - import it there", which is what lets the model fix a wrong import path.
 */
export function locateSymbolSpec(name: string, repoTree: ReadonlySet<string>): string | null {
  if (!name || repoTree.size === 0) return null;
  const forms = new Set([toKebab(name), name.toLowerCase(), name.replace(/_/g, "").toLowerCase()]);
  const matches: string[] = [];
  for (const path of repoTree) {
    const m = path.match(/([^/]+)\.(tsx?|jsx?|mjs|cjs)$/);
    if (!m) continue;
    const baseNoExt = m[1].toLowerCase();
    if (forms.has(baseNoExt) || forms.has(baseNoExt.replace(/\./g, "-"))) matches.push(path);
  }
  if (matches.length === 0) return null;
  // Prefer a src/ path, then the shortest (closest to a top-level module).
  matches.sort((a, b) => (a.startsWith("src/") ? 0 : 1) - (b.startsWith("src/") ? 0 : 1) || a.length - b.length);
  const best = matches[0].replace(/\.(tsx?|jsx?|mjs|cjs)$/, "").replace(/\/index$/, "");
  return best.startsWith("src/") ? "@/" + best.slice(4) : best;
}

/** Resolve one local specifier to a module the pipeline can read. `exists` is
 *  whether ANY candidate path is a file in the repo/changeset; `content` is that
 *  file's source when known (null when it exists but was not fetched). */
export type ModuleResolver = (fromPath: string, spec: string) => { exists: boolean; content: string | null };

/** Imports of a local module that does not exist, or of a name a readable local
 *  module does not export. Fail-open everywhere else. Pure (resolver is injected). */
export function findBrokenLocalImports(
  files: readonly { path: string; content: string }[],
  resolve: ModuleResolver,
): BrokenLocalImport[] {
  const broken: BrokenLocalImport[] = [];
  const changeset = new Set(files.map((f) => f.path));
  for (const file of files) {
    for (const li of extractLocalImports(file.path, file.content)) {
      const r = resolve(file.path, li.spec);
      if (!r.exists) { broken.push({ path: file.path, spec: li.spec, kind: "missing_module" }); continue; }
      if (r.content == null) continue; // exists, unreadable names -> module existence only
      const exp = extractExportedNames(r.content);
      if (exp.hasWildcard) continue; // re-exports unknown names -> cannot prove absence
      for (const name of li.names) {
        if (!exp.names.has(name)) broken.push({ path: file.path, spec: li.spec, kind: "missing_export", name });
      }
      if (li.hasDefault && !exp.hasDefault) broken.push({ path: file.path, spec: li.spec, kind: "missing_export", name: "default" });
    }
  }
  void changeset;
  return broken;
}

/** Fetch the source of the given repo paths for the NAME check. The backend is
 *  injected so one checker serves both callers: GitHub (the live route) and disk
 *  (the local dogfood harness / Model Fitness Test). Returns null for any path it
 *  cannot read (fail-open). */
export type ModuleFetcher = (paths: readonly string[]) => Promise<Map<string, string | null>>;

/**
 * Resolve + name-check every LOCAL import in `files` against the repo tree and
 * the (fetched) source of each target module. The ONE import checker, shared by
 * the live route (GitHub-backed fetcher) and the local harness (disk-backed): a
 * `@/`-alias or relative import that resolves to NO file, or a named symbol a
 * readable local module does NOT export, is returned as broken (it always fails
 * CI). A wrong-symbol import is enriched with where the symbol actually lives.
 * Existence is judged against `repoTree` (authoritative); a name fails OPEN when
 * the module source is unread or re-exports with `export *`. Returns [] on an
 * unknown tree or any failure - never blocks a handoff on a resolver/fetch error.
 */
export async function checkLocalImports(
  files: readonly { path: string; content: string }[],
  ctx: { repoTree: ReadonlySet<string>; aliasMap: Record<string, string> },
  fetchModules: ModuleFetcher,
): Promise<BrokenLocalImport[]> {
  if (ctx.repoTree.size === 0) return [];
  try {
    const changeset = new Map(files.map((f) => [f.path, f.content]));
    const wanted = new Set<string>();
    for (const f of files) {
      for (const li of extractLocalImports(f.path, f.content)) {
        const cands = resolveLocalCandidates(f.path, li.spec, ctx.aliasMap);
        if (cands.some((c) => changeset.has(c))) continue; // authored in THIS change
        for (const c of cands) if (ctx.repoTree.has(c)) { wanted.add(c); break; }
      }
    }
    const repoCache = wanted.size > 0 ? await fetchModules([...wanted]) : new Map<string, string | null>();
    const resolver: ModuleResolver = (fromPath, spec) => {
      for (const cand of resolveLocalCandidates(fromPath, spec, ctx.aliasMap)) {
        if (changeset.has(cand)) return { exists: true, content: changeset.get(cand) ?? null };
        if (ctx.repoTree.has(cand)) return { exists: true, content: repoCache.get(cand) ?? null };
      }
      return { exists: false, content: null };
    };
    const broken = findBrokenLocalImports(files, resolver);
    for (const b of broken) {
      if (b.kind === "missing_export" && b.name) {
        const hint = locateSymbolSpec(b.name, ctx.repoTree);
        if (hint && hint !== b.spec) b.hint = hint;
      }
    }
    return broken;
  } catch {
    return []; // best-effort: never block a handoff on a resolver/fetch failure
  }
}

/** Feedback for the authoring retry: name each bad local import precisely so the
 *  model fixes the path or the symbol. Pure. */
export function brokenLocalImportFeedback(broken: readonly BrokenLocalImport[]): string {
  const lines = broken.map((b) =>
    b.kind === "missing_module"
      ? `- "${b.spec}" (in ${b.path}) does not resolve to any file in the repo. Import from the correct path, or do not import it.`
      : `- "${b.name}" is NOT exported by "${b.spec}" (imported in ${b.path}). ${b.hint ? `Import it from "${b.hint}" instead.` : `Import from the module that actually defines "${b.name}".`}`,
  );
  return [
    "The previous attempt imported local symbols that do not exist and will fail CI",
    '("has no exported member" / "Cannot find module"):',
    ...lines,
    "Only import names that are actually exported by the referenced local module.",
  ].join("\n");
}


export interface ImportFix { path: string; from: string; to: string }

/**
 * Deterministically CORRECT common wrong local imports the model makes, BEFORE the
 * gate - so a fumbled import becomes shipped code instead of a hold. The product
 * thesis: wrap the probabilistic model in deterministic controls. We only ever
 * rewrite an import that currently does NOT resolve to a correction that DOES
 * resolve (verified against the repo tree + this change), so a fix can never break
 * a working import.
 *
 * Handles: the double-prefix mistake (@/src/lib/auth -> @/lib/auth, i.e. the alias
 * prefix followed by its own target dir), and a wrong-module symbol when we can
 * LOCATE where it actually lives (import { requireCapability } from "@/lib/auth"
 * -> "@/lib/auth/require-capability"). Pure.
 */
export function autoFixImports(
  files: readonly { path: string; content: string }[],
  repoTree: ReadonlySet<string>,
  aliasMap: Record<string, string>,
): { files: { path: string; content: string }[]; fixes: ImportFix[] } {
  const changeset = new Set(files.map((f) => f.path));
  const resolves = (fromPath: string, spec: string): boolean =>
    resolveLocalCandidates(fromPath, spec, aliasMap).some((x) => changeset.has(x) || repoTree.has(x));

  const correctionCandidates = (spec: string, names: readonly string[]): string[] => {
    const out: string[] = [];
    // Double-prefix: an alias prefix followed by its own target dir (e.g. "@/" + "src/").
    for (const [pref, target] of Object.entries(aliasMap)) {
      const t = target.replace(/\/$/, "");
      if (t && spec.startsWith(pref + t + "/")) out.push(pref + spec.slice((pref + t + "/").length));
    }
    if (spec.startsWith("@/src/")) out.push("@/" + spec.slice("@/src/".length)); // common even w/o alias map
    // Wrong-module symbol: when the import names a single symbol we can locate elsewhere.
    if (names.length === 1) {
      const located = locateSymbolSpec(names[0], repoTree);
      if (located && located !== spec) out.push(located);
    }
    return [...new Set(out)];
  };

  const fixes: ImportFix[] = [];
  const outFiles = files.map((f) => {
    let content = f.content;
    for (const li of extractLocalImports(f.path, f.content)) {
      if (resolves(f.path, li.spec)) continue; // already fine - never touch a working import
      const cand = correctionCandidates(li.spec, li.names).find((c) => resolves(f.path, c));
      if (cand) {
        content = content.split(`"${li.spec}"`).join(`"${cand}"`).split(`'${li.spec}'`).join(`'${cand}'`);
        fixes.push({ path: f.path, from: li.spec, to: cand });
      }
    }
    return { path: f.path, content };
  });
  return { files: outFiles, fixes };
}


/**
 * Full import correction: the pure fixes (autoFixImports) PLUS a hint relocation for
 * a single wrong-module symbol that an EXISTING module does not export. The
 * broken-import check is INJECTED (it needs IO to read modules), so this stays a
 * pure orchestrator. Returns the corrected files, the applied fixes, and the broken
 * imports that REMAIN - so the caller can decide to escalate ONLY when a fix is not
 * possible, instead of burning a stronger-model call on an import a rewrite fixes.
 */
export async function autoCorrectImports(
  files: readonly { path: string; content: string }[],
  repoTree: ReadonlySet<string>,
  aliasMap: Record<string, string>,
  check: (files: readonly { path: string; content: string }[]) => Promise<BrokenLocalImport[]>,
): Promise<{ files: { path: string; content: string }[]; fixes: ImportFix[]; remaining: BrokenLocalImport[] }> {
  const pure = autoFixImports(files, repoTree, aliasMap);
  const fileArr = pure.files.map((f) => ({ ...f }));
  const fixes: ImportFix[] = [...pure.fixes];
  const broken = await check(fileArr);
  let relocated = false;
  for (const b of broken) {
    if (b.kind !== "missing_export" || !b.hint || !b.name) continue;
    const file = fileArr.find((x) => x.path === b.path);
    if (!file) continue;
    const imp = extractLocalImports(file.path, file.content).find((li) => li.spec === b.spec);
    if (imp && imp.names.length === 1 && imp.names[0] === b.name && !imp.hasDefault) {
      file.content = file.content.split(`"${b.spec}"`).join(`"${b.hint}"`).split(`'${b.spec}'`).join(`'${b.hint}'`);
      fixes.push({ path: b.path, from: b.spec, to: b.hint });
      relocated = true;
    }
  }
  const remaining = relocated ? await check(fileArr) : broken;
  return { files: fileArr, fixes, remaining };
}