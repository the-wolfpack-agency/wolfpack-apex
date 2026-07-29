/**
 * Jest resolver: force allowlisted native-ESM node_modules to load as CJS.
 *
 * ROOT CAUSE (the CI-only, continue-on-error-masked failure)
 * ----------------------------------------------------------
 * scripts/verify.sh exports `NODE_OPTIONS=--experimental-vm-modules` (so the
 * export-pdf renderer's lazy dynamic `import("@react-pdf/renderer")` can load
 * ESM inside Jest's VM). That flag flips one global in jest-resolve:
 *
 *     const runtimeSupportsVmModules = typeof vm.SyntheticModule === 'function';
 *
 * which gates `shouldLoadAsEsm()`:
 *
 *     function cachedShouldLoadAsEsm(path) {
 *       if (!runtimeSupportsVmModules) return false;   // <- without the flag
 *       ...returns true for a .js whose nearest package.json is "type":"module"
 *     }
 *
 * and jest-runtime's CJS `requireModule()` does, BEFORE any transform runs:
 *
 *     if (this.unstable_shouldLoadAsEsm(modulePath)) {
 *       throw new Error(`Must use import to load ES Module: ${modulePath}`);
 *     }
 *
 * So once `--experimental-vm-modules` is on, ANY CommonJS module that does
 * `require("<an ESM-typed .js>")` throws "Must use import to load ES Module"
 * - the transform/`transformIgnorePatterns` allowlist is never consulted.
 * Our chains hit exactly this:
 *   - isomorphic-dompurify (CJS) -> jsdom (CJS) -> html-encoding-sniffer (CJS)
 *     -> require("@exodus/bytes/encoding-lite.js")   ["type":"module" -> ESM]
 *   - export-pdf's `import()` is transpiled to a CJS require of
 *     @react-pdf/renderer ["type":"module" -> ESM]
 *
 * Why it only showed up in CI / shard-2 and not on a warm local run: a plain
 * `npx jest <suite>` does NOT set `--experimental-vm-modules`, so
 * `runtimeSupportsVmModules` is false and `shouldLoadAsEsm` short-circuits to
 * false - the suites pass. Only the verify.sh / CI path (which sets the flag)
 * trips it. The reproduction is `NODE_OPTIONS=--experimental-vm-modules npx
 * jest <suite> --no-cache`. Adding the package to ESM_PACKAGES was necessary
 * (so the transform runs once we get past the require guard) but NOT
 * sufficient (the guard fires first).
 *
 * THE FIX
 * -------
 * jest-resolve's `shouldLoadAsEsm` returns false for any `.cjs` file
 * unconditionally (extension check, before the package.json `"type"` lookup).
 * So: when the default resolver lands on an ESM-typed `.js`/`.mjs` inside one
 * of our allowlisted ESM packages, we transpile it to a sibling-free `.cjs`
 * copy in a cache dir and return THAT path. Jest then treats it as CJS,
 * `require` succeeds, and the file is plain CJS (already downleveled). Each
 * relative `import`/`require` inside the copy is rewritten to the original
 * absolute path, so it re-enters this resolver and gets the same treatment -
 * the whole ESM subtree is covered lazily, only for files actually loaded, and
 * cached on disk keyed by source mtime+size. The real modules (isomorphic-
 * dompurify's DOMPurify+jsdom sanitizer, @react-pdf) run for real; nothing is
 * mocked.
 *
 * This only rewrites resolution for ESM-typed files under the allowlisted
 * packages. Everything else (app code, CJS deps, .json, .node, .wasm) falls
 * straight through to Jest's default resolver untouched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ts = require("typescript");
const { shimImportMeta } = require("./jest.transform.cjs");

// Allowlist of package roots whose ESM-typed .js/.mjs must be served as .cjs.
// This is the SINGLE SOURCE OF TRUTH: jest.config.ts imports ESM_PACKAGE_ROOTS
// from this file to build transformIgnorePatterns, so the resolver and the
// transform allowlist can never drift. A path qualifies when one of these
// names appears as a package segment right after a `node_modules/`.
const ESM_PACKAGE_ROOTS = [
  "@exodus",
  "isomorphic-dompurify",
  "parse5",
  "entities",
  "lru-cache",
  "tough-cookie",
  "@asamuzakjp",
  "@csstools",
  "@react-pdf",
  "fontkit",
  "jay-peg",
  "linebreak",
  "unicode-properties",
  "unicode-trie",
  "bidi-js",
  "hyphen",
  "restructure",
  "dfa",
  "clone",
  "brotli",
  "tiny-inflate",
  "yoga-layout",
  "emoji-regex-xs",
  "vite-compatible-readable-stream",
  "color-string",
  "abs-svg-path",
  "normalize-svg-path",
  "parse-svg-path",
  "svg-arc-to-cubic-bezier",
  "hsl-to-hex",
  "media-engine",
  "postcss-value-parser",
  "is-url",
  "color-name",
];

const CACHE_DIR = path.join(os.tmpdir(), "jest-esm-cjs-cache");

// True when `resolved` lives inside one of the allowlisted ESM packages.
function inEsmAllowlist(resolved) {
  const norm = resolved.replace(/\\/g, "/");
  return ESM_PACKAGE_ROOTS.some((pkg) => norm.includes(`/node_modules/${pkg}/`));
}

// Mirror jest-resolve's `shouldLoadAsEsm` for the `.js` case: only `.js`/`.mjs`
// whose nearest package.json is `"type":"module"` need the CJS rewrite. `.cjs`
// and CJS-typed `.js` already load fine.
function nearestPackageType(file) {
  let dir = path.dirname(file);
  for (;;) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        return JSON.parse(fs.readFileSync(pj, "utf8")).type || "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "commonjs";
    dir = parent;
  }
}

function needsCjsRewrite(resolved) {
  if (!inEsmAllowlist(resolved)) return false;
  const ext = path.extname(resolved);
  if (ext === ".mjs") return true;
  if (ext !== ".js") return false; // .cjs/.json/.node/.wasm: leave alone
  return nearestPackageType(resolved) === "module";
}

// Rewrite EVERY static specifier (relative `./x` AND bare `@exodus/bytes/x`)
// to the ORIGINAL absolute resolved path, so the transpiled `.cjs` copy - which
// lives in a cache dir with no node_modules of its own - never depends on its
// own location for resolution. Each rewritten absolute path re-enters this
// resolver and is itself served as `.cjs` if it is an allowlisted ESM file.
// We resolve from the ORIGINAL file's directory (where the real node_modules
// tree + package "exports" map live), using Jest's resolver semantics is
// overkill here; Node's require.resolve honours the same "exports"/"main"
// fields the runtime would, which is what these intra-package subpath imports
// (e.g. "@exodus/bytes/utf16.js") and bare deps rely on.
const STATIC_SPECIFIER =
  /((?:import|export)\b[^'"]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

function rewriteSpecifiersToAbsolute(source, originalFile) {
  const originalDir = path.dirname(originalFile);
  return source.replace(STATIC_SPECIFIER, (m, head, quote, spec) => {
    // Leave node: builtins and already-absolute paths alone.
    if (spec.startsWith("node:") || path.isAbsolute(spec)) return m;
    let abs;
    try {
      abs = require.resolve(spec, { paths: [originalDir] });
    } catch {
      return m; // unresolvable here (e.g. a core module) - leave for Jest.
    }
    return `${head}${quote}${abs.replace(/\\/g, "/")}${quote}`;
  });
}

function cachedCjsPath(originalFile, src) {
  // Key by absolute path so two packages with same-named files don't collide;
  // include a content hash so a dep upgrade (any change to the source) busts
  // the cache.
  const hash = require("crypto")
    .createHash("md5")
    .update(originalFile)
    .update(src)
    .digest("hex");
  return path.join(CACHE_DIR, `${hash}.cjs`);
}

function ensureCjsCopy(originalFile) {
  // Read the source once and key the cache off its content. Reading first,
  // rather than statSync-then-readFileSync, removes a check-then-use race on
  // originalFile (CodeQL: js/file-system-race) and makes the cache key exact
  // instead of mtime/size based.
  const src = fs.readFileSync(originalFile, "utf8");
  const out = cachedCjsPath(originalFile, src);
  try {
    fs.accessSync(out);
    return out;
  } catch {
    // Not cached yet; transpile and write it below.
  }
  const rewritten = rewriteSpecifiersToAbsolute(shimImportMeta(src), originalFile);
  const transpiled = ts.transpileModule(rewritten, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      allowJs: true,
      isolatedModules: true,
    },
    // `.ts` fileName so TS honours the CommonJS module emit (it keys emit off
    // the extension; a .mjs/ESM-typed-.js name would force ESNext).
    fileName: originalFile.replace(/\.[cm]?jsx?$/, ".ts"),
  }).outputText;
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  // Atomic write so parallel workers never read a half-written file. The suffix
  // is crypto-random, not Math.random: CACHE_DIR lives in the shared os.tmpdir(),
  // where a predictable name lets a local peer pre-create or symlink the target
  // and steer our write (CodeQL: js/insecure-temporary-file). 0600 + wx so we
  // fail rather than follow an existing path.
  const suffix = require("crypto").randomBytes(12).toString("hex");
  const tmp = `${out}.${process.pid}.${suffix}.tmp`;
  fs.writeFileSync(tmp, transpiled, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, out);
  } catch {
    // A peer worker won the race; its copy is byte-identical (same key).
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
  return out;
}

module.exports = (request, options) => {
  const resolved = options.defaultResolver(request, options);
  if (typeof resolved === "string" && needsCjsRewrite(resolved)) {
    try {
      return ensureCjsCopy(resolved);
    } catch {
      // If anything goes wrong, fall back to the real path - worst case the
      // original error resurfaces rather than a silent miscompile.
      return resolved;
    }
  }
  return resolved;
};

// Single source of truth for the ESM allowlist: jest.config.ts imports this so
// transformIgnorePatterns and the resolver can never drift apart (DRY).
module.exports.ESM_PACKAGE_ROOTS = ESM_PACKAGE_ROOTS;
