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
