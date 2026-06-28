/**
 * Jest transformer: ts-jest + an `import.meta` shim for native-ESM deps.
 *
 * Why this exists
 * ---------------
 * A few allowlisted node_modules ship native ESM (see ESM_PACKAGES in
 * jest.config.ts). ts-jest transpiles their `import`/`export` to CommonJS,
 * but TypeScript (module: commonjs) leaves `import.meta` untouched, so V8
 * throws "Cannot use 'import.meta' outside a module" at runtime.
 *
 * The only offender in our chains is yoga-layout's base64-embedded WASM
 * loader (`yoga-layout/dist/binaries/yoga-wasm-base64-esm.js`), which
 * references `import.meta.url` purely as the Emscripten `_scriptDir`
 * fallback for locating a `.wasm` file on disk. Because that build embeds
 * the WASM as base64, the value is never actually used - it is safe to
 * replace `import.meta.url` with the file's CJS `__filename`-derived URL.
 *
 * We do the replacement BEFORE ts-jest sees the source, only for `.js`
 * files under node_modules (our app/test `.ts` never uses import.meta),
 * then delegate everything else to the stock ts-jest transformer. This is
 * a syntactic shim, not a behavioural change: no test assertion is
 * relaxed, and yoga still renders real layout.
 *
 * The forced-CJS transpile (`transpileEsm` / `shimImportMeta`) is also
 * reused by jest.resolver.cjs - see the long comment there for the CI-only
 * "Must use import to load ES Module" root cause it solves.
 */
const tsJest = require("ts-jest").default;
const ts = require("typescript");

const IMPORT_META_URL = /import\.meta\.url/g;
// Any other `import.meta.<x>` access -> undefined-safe empty object.
const IMPORT_META_BARE = /import\.meta\b/g;

function shimImportMeta(src) {
  if (!src.includes("import.meta")) return src;
  return src
    .replace(IMPORT_META_URL, "require('url').pathToFileURL(__filename).href")
    .replace(IMPORT_META_BARE, "({})");
}

// ts-jest's createTransformer returns the actual transformer object. We
// forward the same tsconfig used by the inline transform in jest.config.ts
// so JS files in node_modules get allowJs transpilation to CommonJS.
const inner = tsJest.createTransformer({
  tsconfig: {
    module: "commonjs",
    moduleResolution: "node",
    jsx: "react-jsx",
    allowJs: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    // Avoids type-checking node_modules ESM we transpile; matches the
    // single-file emit ts-jest does. (Set here rather than tsconfig.json
    // so the project's tsconfig is untouched.)
    isolatedModules: true,
  },
});

// Routing: which files get the forced-CJS TypeScript transpile vs ts-jest.
//
// Anything under node_modules only reaches this transformer because it is
// allowlisted in transformIgnorePatterns (i.e. it is native ESM we must
// downlevel). We hand those to `transpileEsm` (forced CJS emit, see below)
// rather than ts-jest's `inner.process`, so the emit is deterministic and
// never depends on ts-jest's per-file module-kind detection or the dep's
// package.json `"type"`. App/test `.ts`/`.tsx` sources (never under
// node_modules) flow through ts-jest unchanged, preserving project tsconfig
// + diagnostics.
//
// NB: under `--experimental-vm-modules` (which scripts/verify.sh sets so the
// export-pdf renderer's dynamic import() can load) Jest REFUSES to `require`
// an ESM-typed `.js` BEFORE any transform runs, so the transform alone is not
// enough for CJS-require-of-ESM chains. jest.resolver.cjs handles that by
// resolving those files to pre-transpiled `.cjs` copies, which then flow back
// through this transformer's node_modules path. See jest.resolver.cjs.
function isNodeModules(p) {
  return p.includes("node_modules");
}

function transpileEsm(sourceText, sourcePath) {
  const out = ts.transpileModule(shimImportMeta(sourceText), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      allowJs: true,
      isolatedModules: true,
    },
    // IMPORTANT: TypeScript picks the emit module kind from the file
    // extension - a `.mjs`/`.cjs` (and an ESM-typed `.js`) name forces ESNext
    // and ignores our CommonJS request. Passing a `.ts` fileName makes the
    // CommonJS module emit actually apply. Behaviour is identical to the
    // original ESM file; only the emit target changes.
    fileName: sourcePath.replace(/\.[cm]?jsx?$/, ".ts"),
  });
  return { code: out.outputText };
}

module.exports = {
  // Keep ts-jest's cache key for app/test sources so we still benefit from
  // caching; salt it so a shim change busts the cache. node_modules files use
  // a self-contained key (they never touch ts-jest's program).
  getCacheKey(sourceText, sourcePath, options) {
    if (isNodeModules(sourcePath)) {
      return (
        require("crypto")
          .createHash("md5")
          .update(shimImportMeta(sourceText))
          .update(sourcePath)
          .digest("hex") + ":esm-transpile-v2"
      );
    }
    return inner.getCacheKey(sourceText, sourcePath, options) + ":importmeta-shim-v1";
  },
  process(sourceText, sourcePath, options) {
    // Anything under node_modules only reaches us because it is allowlisted in
    // transformIgnorePatterns (i.e. it is native ESM we must downlevel).
    // Force-transpile it to CJS regardless of extension or package "type".
    if (isNodeModules(sourcePath)) {
      return transpileEsm(sourceText, sourcePath);
    }
    return inner.process(sourceText, sourcePath, options);
  },
};

// Reused by jest.resolver.cjs so the forced-CJS transpile logic lives in
// exactly one place (DRY): the resolver pre-transpiles ESM-typed node_modules
// files to `.cjs` copies with this same `shimImportMeta` + `transpileEsm`.
module.exports.shimImportMeta = shimImportMeta;
module.exports.transpileEsm = transpileEsm;
