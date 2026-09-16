/**
 * DRY gate: catch a NEW function/class re-implemented under a name that already
 * exists elsewhere in the repo.
 *
 * This session is the reason it exists: an agent (me) generated a second gate
 * that duplicated one already in src/lib/ai-code, and nothing caught it except a
 * manual scan. Duplicated code is the sloppy/unsafe outcome the operator called
 * out. A name collision is not proof of duplication, so this is a RATCHET, not
 * an accusation: today's collisions are baselined, and only a NEW one fails the
 * build - at which point the author either reuses the existing symbol or, if it
 * is genuinely distinct, records it in the baseline with intent.
 *
 * Scoped deliberately to `export function` / `export class` declarations. Types
 * and interfaces legitimately share names across modules (Result, Finding), and
 * route handlers all export GET/POST; including those would be noise, and a
 * noisy guardrail gets disabled.
 */

export interface SourceFile {
  path: string;
  content: string;
}

/** Next.js route/page/framework exports that are SUPPOSED to repeat everywhere. */
const RESERVED = new Set<string>([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
  "preferredRegion", "maxDuration", "metadata", "generateMetadata",
  "generateStaticParams", "generateViewport", "viewport", "default",
  "config", "middleware",
]);

const DECL = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/;

/** name -> the set of files that declare an exported function/class of that name. */
export function indexFunctionClassExports(files: SourceFile[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const f of files) {
    for (const line of f.content.split("\n")) {
      const m = DECL.exec(line);
      if (!m) continue;
      const name = m[1];
      // `_`/`__`-prefixed names are test/reset hooks duplicated per-module by
      // convention (_isRateLimited, __resetForTests); not a duplication smell.
      if (RESERVED.has(name) || name.startsWith("_")) continue;
      if (!idx.has(name)) idx.set(name, new Set());
      idx.get(name)!.add(f.path);
    }
  }
  return idx;
}

/** name -> sorted files, for every name declared in more than one file. */
export function findCollisions(idx: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, files] of idx) {
    if (files.size > 1) out[name] = [...files].sort();
  }
  return out;
}
