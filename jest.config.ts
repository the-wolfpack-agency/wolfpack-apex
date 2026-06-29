import type { Config } from "jest";
// Single source of truth for the native-ESM allowlist lives in the resolver
// (a .cjs so the resolver itself can require it without a TS build step). Both
// transformIgnorePatterns (below) and the resolver derive from this one list,
// so they can never drift apart.
const { ESM_PACKAGE_ROOTS } = require("./jest.resolver.cjs") as {
  ESM_PACKAGE_ROOTS: string[];
};

/**
 * ESM-in-node_modules allowlist.
 *
 * A handful of dependencies ship as native ESM ("type": "module" with bare
 * `import`/`export` in their published `.js`). Jest runs under CommonJS, so
 * those files must be transpiled. The default `transformIgnorePatterns`
 * (`/node_modules/`) skips ALL of node_modules, so these never get
 * transformed and fail with "Unexpected token 'export'" /
 * "Cannot use import statement outside a module".
 *
 * We do NOT transform all of node_modules (slow, and risks breaking deps
 * that ship CJS but trip ts-jest). Instead we allowlist exactly the ESM
 * packages that appear in our import chains, discovered by reading the
 * failing stack traces:
 *
 *   - isomorphic-dompurify bundles its own jsdom → html-encoding-sniffer →
 *     @exodus/bytes (the ESM file that actually throws).
 *   - @react-pdf/renderer (export-pdf) is ESM and pulls in a tree of ESM
 *     siblings (@react-pdf/*) plus ESM-only leaf deps (fontkit, jay-peg,
 *     linebreak, unicode-properties, bidi-js, hyphen, restructure, ...).
 *
 * Keep this list tight: add a package only when a stack trace shows its
 * published `.js` using `import`/`export` under /node_modules/.
 */
const ESM_PACKAGES = ESM_PACKAGE_ROOTS;

const config: Config = {
  testEnvironment: "node",
  preset: "ts-jest",
  // Recycle a worker once its heap crosses 512MB. The ~13k-test suite leaks
  // heap across files inside a long-lived worker; on a loaded CI runner that
  // bloat starves the worker and triggers GC stalls that blow the 5s default
  // timeout on otherwise-deterministic tests (ms-graph-chats,
  // email-signatures-detect, engine-politeness, export-pdf flaked in CI but
  // pass 3/3 locally). Recycling the worker before the bloat lands fixes the
  // root cause. We do NOT set a global testTimeout: a longer timeout would
  // only mask slowness instead of removing it, and would let a genuinely slow
  // test sail through. workerIdleMemoryLimit is a native Jest knob - no dep.
  workerIdleMemoryLimit: "512MB",
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}"],
  // ts-jest's preset omits mjs/cjs; some allowlisted ESM deps resolve to
  // .mjs via package "exports", so Jest must know to look for them.
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "node"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  // Custom resolver = Jest's default resolver + a CJS-rewrite for the
  // allowlisted native-ESM node_modules. REQUIRED because scripts/verify.sh
  // runs Jest with `--experimental-vm-modules` (so export-pdf's dynamic
  // import() can load @react-pdf): under that flag jest-resolve refuses to
  // `require()` any ESM-typed `.js` (it throws "Must use import to load ES
  // Module: .../@exodus/bytes/encoding-lite.js") BEFORE the transform runs, so
  // the transformIgnorePatterns allowlist alone is insufficient. The resolver
  // serves those files as pre-transpiled `.cjs` copies (which jest-resolve
  // always treats as CJS), so the require chains
  // (isomorphic-dompurify -> jsdom -> @exodus/bytes; @react-pdf) load for real
  // without mocking the sanitizer. Full root-cause writeup in
  // jest.resolver.cjs. Reproduce with:
  //   NODE_OPTIONS=--experimental-vm-modules npx jest <suite> --no-cache
  resolver: "<rootDir>/jest.resolver.cjs",
  transform: {
    // Custom transformer = ts-jest + an `import.meta` shim for the ESM
    // node_modules we allowlist below (yoga-layout's WASM loader). It also
    // sets allowJs so ts-jest can transpile those ESM .js files. App/test
    // .ts/.tsx flow straight through to ts-jest unchanged.
    "^.+\\.[cm]?[jt]sx?$": "<rootDir>/jest.transform.cjs",
  },
  transformIgnorePatterns: [
    `/node_modules/(?!(${ESM_PACKAGES.join("|")})/)`,
  ],
};

export default config;
