/**
 * Factory brain #7: did a RETRIEVED reuse suggestion actually get USED in the
 * authored change? The brain surfaces existing code to reuse; the author may use
 * it or ignore it. Only a suggestion that was used should earn credit when the PR
 * merges (and escape blame when it is rejected). This is the precise
 * credit-assignment signal the reinforcement driver consumes.
 *
 * Pure + deterministic (no model): a reuse path counts as USED when the authored
 * diff references it - the author edited that very file, named its path, or
 * imported the module it defines. Conservative by design: a miss just means that
 * suggestion earns no reinforcement, never a wrong adjustment.
 */
import type { ProvenanceEntry } from "./factory-provenance";

/** Drop a trailing file extension: src/lib/foo/bar.ts -> src/lib/foo/bar. */
function stripExt(path: string): string {
  return path.replace(/\.[A-Za-z0-9]+$/, "");
}

/** Import/require specifiers on a single diff line (linear scan, ReDoS-safe). */
function specifiersOnLine(line: string): string[] {
  if (!/\b(?:import|require|from)\b/.test(line)) return [];
  const out: string[] = [];
  // One pass over quoted strings on the line; a single class, one quantifier.
  for (const m of line.matchAll(/['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/**
 * True when the authored `diff` references the repo `path` - i.e. the author
 * USED the suggested code. Matches: the full path (a diff file header or any
 * mention), the path without extension, or an import specifier that resolves to
 * it (the `@/` alias for `src/`, or a relative import ending in the module tail).
 */
export function referencesPath(diff: string, path: string): boolean {
  if (!diff || !path) return false;
  const noExt = stripExt(path);
  // The author touched / named the very file.
  if (diff.includes(path) || diff.includes(noExt)) return true;
  // An import whose specifier resolves to this module.
  const alias = "@/" + noExt.replace(/^src\//, ""); // @/lib/foo/bar
  const segs = noExt.split("/");
  const tail1 = "/" + segs.slice(-1).join("/"); // /bar
  const tail2 = "/" + segs.slice(-2).join("/"); // /foo/bar
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") && !line.startsWith(" ")) continue; // added/context only
    for (const spec of specifiersOnLine(line)) {
      if (spec === alias || spec === noExt || spec.endsWith(tail2) || spec.endsWith(tail1)) return true;
    }
  }
  return false;
}

/**
 * Mark `used` on each REUSE entry by whether the authored diff references its
 * path. Failure entries are returned unchanged (used stays whatever it was, and
 * is not meaningful for them). Pure - returns a new array.
 */
export function markReuseUsage(entries: readonly ProvenanceEntry[], diff: string): ProvenanceEntry[] {
  return entries.map((e) =>
    e.kind === "reuse" ? { ...e, used: referencesPath(diff, e.key) } : { ...e },
  );
}
