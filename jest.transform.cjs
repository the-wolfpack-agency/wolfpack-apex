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

// ts-jest only understands .js/.jsx/.ts/.tsx. Allowlisted ESM deps that
// ship .mjs / .cjs (e.g. @csstools/css-tokenizer/dist/index.mjs) must be
// transpiled directly via the TypeScript compiler, after the import.meta
// shim. App/test sources are never .mjs/.cjs, so this only ever touches
// node_modules.
function isExplicitEsmExt(p) {
  return p.endsWith(".mjs") || p.endsWith(".cjs");
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
    // IMPORTANT: TypeScript refuses to downlevel ESM for files named .mjs
    // / .mts (it forces ESNext module emit by extension). We pass a .ts
    // fileName so the CommonJS module emit actually applies. Behaviour is
    // identical to a .js ESM file; only the emit target changes.
    fileName: sourcePath.replace(/\.[cm]js$/, ".ts"),
  });
  return { code: out.outputText };
}

module.exports = {
  // Keep ts-jest's cache key so we still benefit from caching; salt it so a
  // shim change busts the cache.
  getCacheKey(sourceText, sourcePath, options) {
    if (isExplicitEsmExt(sourcePath)) {
      return (
        require("crypto")
          .createHash("md5")
          .update(shimImportMeta(sourceText))
          .update(sourcePath)
          .digest("hex") + ":esm-transpile-v1"
      );
    }
    const shimmed = sourcePath.includes("node_modules")
      ? shimImportMeta(sourceText)
      : sourceText;
    return inner.getCacheKey(shimmed, sourcePath, options) + ":importmeta-shim-v1";
  },
  process(sourceText, sourcePath, options) {
    if (isExplicitEsmExt(sourcePath)) {
      return transpileEsm(sourceText, sourcePath);
    }
    const shimmed = sourcePath.includes("node_modules")
      ? shimImportMeta(sourceText)
      : sourceText;
    return inner.process(shimmed, sourcePath, options);
  },
};
