import type { Config } from "jest";

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
const ESM_PACKAGES = [
  // isomorphic-dompurify bundles its own jsdom; this tree is ESM:
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

const config: Config = {
  testEnvironment: "node",
  preset: "ts-jest",
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}"],
  // ts-jest's preset omits mjs/cjs; some allowlisted ESM deps resolve to
  // .mjs via package "exports", so Jest must know to look for them.
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "node"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
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
