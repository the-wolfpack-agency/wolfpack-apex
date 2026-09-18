/**
 * Forcefield for the Web - page-trap generator.
 *
 * The same decoy idea as the agent-side canary, placed in a web page: a hidden
 * link a person never sees and a well-behaved agent never follows, because
 * robots.txt disallows it. A scraper that grabs everything and ignores the rules
 * trips it and reveals itself.
 *
 * Deterministic: the same seed always yields the same trap path, so a site can
 * regenerate its traps idempotently and the classifier's trapPaths stay stable
 * across deploys. No randomness (which would also make the path un-reproducible).
 */

export interface PageTrap {
  /** The honeypot path to register in SiteForcefieldConfig.trapPaths. */
  path: string;
  /** Invisible, un-focusable, nofollow anchor to embed in the page. A human
   *  never sees it; a scraper that harvests every href follows it. */
  html: string;
  /** The robots.txt line that tells a well-behaved agent to stay away, so only
   *  a rule-ignoring scraper ever reaches the trap. */
  robotsDisallow: string;
}

/** A stable, non-crypto string hash (FNV-1a). Enough to make a trap path that is
 *  reproducible from a seed and not an obvious guess; it is not a secret. */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // FNV prime, kept in 32-bit range.
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned hex, padded.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Prefix for every generated trap path, so they are easy to recognize and to
 *  disallow as a group in robots.txt if desired. */
export const TRAP_PATH_PREFIX = "/_ff";

/**
 * Build a deterministic page trap from a seed (e.g. a page id or a per-site
 * salt). Same seed -> same trap, every time.
 */
export function makePageTrap(seed: string): PageTrap {
  const slug = stableHash(seed);
  const path = `${TRAP_PATH_PREFIX}/${slug}`;
  const html =
    `<a href="${path}" aria-hidden="true" tabindex="-1" rel="nofollow"` +
    ` style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden">` +
    `<!-- do not follow --></a>`;
  return {
    path,
    html,
    robotsDisallow: `Disallow: ${path}`,
  };
}

/** Build traps for many seeds at once, de-duplicated by path. */
export function makePageTraps(seeds: readonly string[]): PageTrap[] {
  const byPath = new Map<string, PageTrap>();
  for (const seed of seeds) {
    const trap = makePageTrap(seed);
    byPath.set(trap.path, trap);
  }
  return [...byPath.values()];
}
