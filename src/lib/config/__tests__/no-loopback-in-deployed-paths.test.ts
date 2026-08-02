/**
 * Ratchet: no new loopback default on a path that runs in production.
 *
 * From a real alert (2026-08-02): repeated ECONNREFUSED to 127.0.0.1 for
 * /dms/wolfpack-auto/inventory-search. One line caused it, and it reads
 * perfectly well in review:
 *
 *   process.env.DMS_DRIVER_URL ?? "http://127.0.0.1:7421"
 *
 * On a developer machine that is exactly right, which is why nobody caught it.
 * In a serverless function 127.0.0.1 is the function itself.
 *
 * Fixing the one instance leaves the pattern available, and the next one will
 * read just as reasonably. resolveServiceUrl() makes the decision once; this
 * makes sure new code goes through it.
 *
 * The allowlist may SHRINK and never grow, and a stale entry fails too, so it
 * cannot rot into permanent permission.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");

/**
 * A loopback address used as a FALLBACK — `?? "http://localhost"` or
 * `: "http://127.0.0.1"`. Deliberately narrow: a loopback string in a comment,
 * a test fixture or a URL being parsed is not this bug, and a broad match would
 * go noisy and get switched off.
 */
const LOOPBACK_DEFAULT = /(?:\?\?|\|\||[:=])\s*["'`]https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)/;

/**
 * Files allowed a loopback default, with the reason.
 *
 * Each entry must be code that CANNOT run in a deployed request path, or the
 * exemption is just the bug with paperwork.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "lib/platform-scan/benchmark/corpus.ts":
    "Targets deliberately-vulnerable apps (juice-shop, VAmPI, NodeGoat) that are stood up locally or in CI for the benchmark sweep. A deployed function has no such host, and the sweep is not reachable from a request.",
};

/** Directories that only ever run on a developer machine or in CI. */
const NOT_DEPLOYED = ["__tests__", "__mocks__"];

function walk(dir: string, prefix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (NOT_DEPLOYED.includes(entry) || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("no loopback default reaches a deployed path", () => {
  const files = [...walk(join(SRC, "lib"), "lib"), ...walk(join(SRC, "app"), "app")];
  const offenders = files
    // The helper itself necessarily contains the pattern: its reason string
    // quotes the local default back to the reader. The fix is not an offender.
    .filter((rel) => rel !== "lib/config/local-default.ts")
    .filter((rel) => LOOPBACK_DEFAULT.test(readFileSync(join(SRC, rel), "utf-8")))
    .sort();

  it("scans a meaningful number of files, so a broken walk cannot pass by finding nothing", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("catches the exact line that caused the incident", () => {
    // A guardrail nobody has seen fire is a guardrail nobody knows works.
    expect(LOOPBACK_DEFAULT.test('process.env.DMS_DRIVER_URL ?? "http://127.0.0.1:7421"')).toBe(true);
    expect(LOOPBACK_DEFAULT.test('const u = process.env.X || "http://localhost:3000";')).toBe(true);
    expect(LOOPBACK_DEFAULT.test('baseUrl: "http://localhost:8080"')).toBe(true);
  });

  it("does not fire on things that are not this bug", () => {
    // Noise is how a guardrail gets disabled. A loopback string being parsed,
    // compared or written about is not a fallback.
    expect(LOOPBACK_DEFAULT.test('// dev runs on http://localhost:3000')).toBe(false);
    expect(LOOPBACK_DEFAULT.test('expect(isLoopbackUrl("http://127.0.0.1")).toBe(true)')).toBe(false);
    expect(LOOPBACK_DEFAULT.test('new URL("http://localhost:3000")')).toBe(false);
  });

  it("has no unlisted file using a loopback default", () => {
    const unlisted = offenders.filter((f) => !(f in ALLOWED));
    expect({
      hint: "Use resolveServiceUrl() from lib/config/local-default, which returns a typed 'not configured' in a deployed function instead of dialling this container.",
      unlisted,
    }).toEqual({ hint: expect.any(String), unlisted: [] });
  });

  it("has no stale allowlist entry", () => {
    const stale = Object.keys(ALLOWED).filter((f) => !offenders.includes(f));
    expect({ hint: "No longer uses a loopback default. Remove it from ALLOWED.", stale }).toEqual({
      hint: expect.any(String),
      stale: [],
    });
  });
});
