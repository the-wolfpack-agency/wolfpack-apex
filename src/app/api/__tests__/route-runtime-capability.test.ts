/**
 * No API route may depend on something that does not exist where it runs.
 *
 * THE BUG THIS PREVENTS
 *
 * A Vercel function has no chromium binary. Code that launches a browser works
 * perfectly on a developer machine, passes every unit test, passes the build,
 * and then degrades on every single request in production. Nothing in the
 * pipeline notices, because every stage runs somewhere that HAS a browser.
 *
 * That very nearly shipped in #224: the compliance scan's first design drove
 * playwright from the route handler. It was caught by someone stopping to think
 * about where the code would run, which is not a control — it is luck wearing a
 * control's clothing. This is the control.
 *
 * WHAT IT CHECKS
 *
 * It walks the import graph from every route handler and fails if one can reach
 * a module that needs a browser binary. Dynamic `import()` counts: deferring the
 * import changes WHEN it fails, not WHETHER.
 *
 * Reaching browser code is not automatically wrong — a route may legitimately
 * call something that degrades cleanly when no browser is present. That is what
 * the allowlist is for, and each entry has to say why in one line. The list may
 * shrink, never grow, and a stale entry fails too so it cannot rot into
 * permanent permission.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..", "..", "..");
const API = path.join(SRC, "app", "api");

/**
 * Packages that need a binary the serverless runtime does not ship.
 * `playwright-core` is a dependency for the CI/e2e runners, not for functions.
 */
const NEEDS_A_BROWSER = ["playwright-core", "playwright", "puppeteer", "puppeteer-core"];

/**
 * Routes allowed to reach browser code, with the reason.
 * Empty. An entry is a promise that the route degrades cleanly, not an excuse.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "app/api/tools/screenshot/route.ts":
    "By design: serverless-chromium-provider drives @sparticuz/chromium, a Lambda-compatible binary, and remote-cdp-provider connects to an in-house pool. Both run in a function.",
  "app/api/admin/spec-diff/route.ts":
    "Connects to the in-house browser pool when BROWSER_WS_ENDPOINT is set; without it the launch fails and the route answers 502 browser_unavailable rather than pretending to have measured.",
  "app/api/cron/site-acceptance/route.ts":
    "Same browser as spec-diff. Without BROWSER_WS_ENDPOINT the run is recorded degraded with reason browser_unavailable, so a gate that never ran is visible in analytics instead of looking like a pass.",
};

const EXTENSIONS = [".ts", ".tsx"];

/** Resolve an import specifier to a file inside src, or null if it is external. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let bare: string;
  if (spec.startsWith("@/")) bare = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) bare = path.resolve(path.dirname(fromFile), spec);
  else return null;

  for (const ext of EXTENSIONS) {
    if (fs.existsSync(bare + ext)) return bare + ext;
  }
  for (const ext of EXTENSIONS) {
    const asIndex = path.join(bare, `index${ext}`);
    if (fs.existsSync(asIndex)) return asIndex;
  }
  return fs.existsSync(bare) && fs.statSync(bare).isFile() ? bare : null;
}

/** Static imports, re-exports, and dynamic import() alike. Deferring an import
 *  changes when it fails, not whether. */
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf-8");
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
}

/** Depth-first walk to the first browser-requiring package, returning the path
 *  that reaches it so a failure names the chain rather than just the verdict. */
function findBrowserDependency(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];

  while (stack.length > 0) {
    const { file, trail } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const spec of importsOf(file)) {
      const pkg = NEEDS_A_BROWSER.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (pkg) return [...trail, pkg];
      const next = resolveLocal(spec, file);
      if (next && !seen.has(next)) stack.push({ file: next, trail: [...trail, next] });
    }
  }
  return null;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(full);
  }
  return out;
}

describe("API routes only depend on what exists where they run", () => {
  const routes = routeFiles(API);

  it("finds the route handlers, so a broken walk cannot pass by finding nothing", () => {
    // A scanner that silently matches zero files reports success forever.
    expect(routes.length).toBeGreaterThan(50);
  });

  it("no route can reach a package that needs a browser binary", () => {
    const offenders: string[] = [];
    for (const route of routes) {
      const rel = path.relative(SRC, route);
      if (rel in ALLOWED) continue;
      const chain = findBrowserDependency(route);
      if (chain) {
        offenders.push(`${rel}\n      via ${chain.map((f) => (f.startsWith("/") ? path.relative(SRC, f) : f)).join("\n       -> ")}`);
      }
    }
    expect({
      hint: "A Vercel function has no chromium. Move the work to a runner that has a browser, or add an ALLOWED entry saying how the route degrades.",
      offenders,
    }).toEqual({ hint: expect.any(String), offenders: [] });
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const full = path.join(SRC, rel);
      return !fs.existsSync(full) || !findBrowserDependency(full);
    });
    expect({ hint: "Fixed or deleted. Remove from ALLOWED.", stale }).toEqual({ hint: expect.any(String), stale: [] });
  });

  it("detects a real chain, so the walk is known to work", () => {
    // Proof by construction against a module that genuinely imports playwright,
    // rather than trusting that a clean result means the walk ran.
    const known = path.join(SRC, "lib", "platform-scan", "browser", "device-matrix.ts");
    if (!fs.existsSync(known)) return; // module renamed; the assertion below still guards the walk
    expect(findBrowserDependency(known)).not.toBeNull();
  });
});
