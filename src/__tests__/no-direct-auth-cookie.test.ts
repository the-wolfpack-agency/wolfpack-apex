/**
 * Guardrail: auth/session cookies may ONLY be written through setAuthCookie()
 * (and cleared through clearAuthCookie()) in src/lib/crypto/cookies.ts. A direct
 * `response.cookies.set(<auth cookie>, ...)` anywhere else lets the hardened
 * flags (HttpOnly / Secure / SameSite / Path / Max-Age) drift per endpoint - the
 * exact class of bug the helper exists to prevent.
 *
 * This started as a factory-authored draft (the Secure Agent dogfood) that only
 * matched the literal names 'auth'/'session' and `.set('literal'` - which never
 * catch apex's real `.cookies.set(ACCESS_TOKEN_COOKIE, ...)` variable-based
 * calls, so it passed by finding nothing. Hardened here to key on the REAL
 * auth-cookie identifiers (the constants AND their string values), to detect the
 * real `.cookies.set(` call shape, and to PROVE it fails when a violation is
 * introduced.
 */
import fs from "fs";
import path from "path";

const SRC_ROOT = path.join(__dirname, "..");

/** The only file allowed to write auth cookies directly (paths relative to src,
 *  forward-slashed). setAuthCookie / clearAuthCookie live here. */
const EXCEPTIONS = ["lib/crypto/cookies.ts"];

/** The canonical auth-cookie identifiers a direct `.cookies.set()` might name:
 *  the exported constants AND their literal string values. Keying on these (not
 *  a vague 'auth'/'session') is what makes the guardrail actually bite. */
const AUTH_COOKIE_TOKENS = [
  "ACCESS_TOKEN_COOKIE",
  "REFRESH_TOKEN_COOKIE",
  "instinct_access_token",
  "instinct_refresh_token",
];

/**
 * Find direct auth-cookie writes in a source string: a `.cookies.set(` call whose
 * FIRST argument references an auth-cookie identifier. Pure and exported so the
 * detector itself is unit-tested (prove-it-fails), not just run over the tree.
 */
export function findDirectAuthCookieSets(content: string): string[] {
  const hits: string[] = [];
  const re = /\.cookies\.set\s*\(\s*([^,)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const firstArg = m[1];
    if (AUTH_COOKIE_TOKENS.some((tok) => firstArg.includes(tok))) hits.push(firstArg.trim());
  }
  return hits;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => path.relative(SRC_ROOT, file).split(path.sep).join("/");

describe("no direct auth-cookie writes outside setAuthCookie", () => {
  it("no file other than cookies.ts writes an auth cookie via .cookies.set()", () => {
    const violations: { file: string; call: string }[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const relPath = rel(file);
      if (EXCEPTIONS.includes(relPath)) continue;
      if (relPath.includes("__tests__") || /\.test\.tsx?$/.test(relPath)) continue; // tests may reference the names as data
      for (const call of findDirectAuthCookieSets(fs.readFileSync(file, "utf8"))) {
        violations.push({ file: relPath, call });
      }
    }
    expect(violations).toEqual([]);
  });

  it("PROOF - flags a direct set by the cookie CONSTANT", () => {
    const offending = `res.cookies.set(ACCESS_TOKEN_COOKIE, token, { httpOnly: true });`;
    expect(findDirectAuthCookieSets(offending)).toHaveLength(1);
  });

  it("PROOF - flags a direct set by the LITERAL cookie name", () => {
    const offending = `response.cookies.set("instinct_refresh_token", value, {});`;
    expect(findDirectAuthCookieSets(offending)).toHaveLength(1);
  });

  it("does NOT flag the sanctioned setAuthCookie() call site", () => {
    // Call sites go through the helper - not a direct .cookies.set of an auth name.
    const ok = `setAuthCookie(res, ACCESS_TOKEN_COOKIE, token, ACCESS_TOKEN_TTL);`;
    expect(findDirectAuthCookieSets(ok)).toEqual([]);
  });

  it("does NOT flag a non-auth cookie set", () => {
    const ok = `res.cookies.set("theme", "dark", { path: "/" });`;
    expect(findDirectAuthCookieSets(ok)).toEqual([]);
  });
});
