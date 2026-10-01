/**
 * Export grounding - put the REAL exported names of the modules a task is most
 * likely to import from in front of the author, so it imports a symbol that
 * exists instead of inventing one.
 *
 * This closes the gap the dogfooding found: the local-import GATE (imports.ts)
 * and self-heal catch a hallucinated import AFTER authoring; the reuse-scout
 * surfaces relevant file PATHS but not their exports. #229 happened because the
 * module the spec named (`@/lib/admin/guest-profile`) was never fetched, so the
 * model had no ground truth and wrote `listAllGuests`, which does not exist. The
 * adversarial dogfood proved the inverse: when the module IS in context the model
 * corrects even a deliberately-wrong name. So: always list the exact exports of
 * the relevant modules, and the #229 class becomes impossible for ANY model -
 * the cheapest one included.
 *
 * Pure except where noted; reuses extractExportedNames from imports.ts. The
 * fetching/orchestration lives in the pipeline route (same place grounding does).
 */
import { extractExportedNames } from "./imports";

export interface ModuleExportsEntry {
  /** The import specifier the author would write, e.g. "@/lib/admin/analytics". */
  specifier: string;
  /** Exact exported names. */
  names: string[];
  /** Whether the module has a default export. */
  hasDefault: boolean;
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/**
 * The import specifier the author would write for a repo path, using the
 * tsconfig alias map in reverse (e.g. {"@/":"src/"} turns "src/lib/x.ts" into
 * "@/lib/x"). Falls back to a repo-root-relative specifier. Pure.
 */
export function toImportSpecifier(path: string, aliasMap: Record<string, string>): string {
  const noExt = path.replace(CODE_EXT, "").replace(/\/index$/, "");
  // Prefer the alias whose target is the LONGEST matching prefix (most specific).
  // A root alias (target "") matches everything and is the lowest-priority choice.
  let bestAlias = "";
  let bestTargetLen = -1;
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (target === "") {
      if (bestTargetLen < 0) { bestAlias = alias; bestTargetLen = 0; }
      continue;
    }
    if (noExt.startsWith(target) && target.length > bestTargetLen) {
      bestAlias = alias;
      bestTargetLen = target.length;
    }
  }
  if (bestAlias) {
    const target = aliasMap[bestAlias];
    return bestAlias + noExt.slice(target.length);
  }
  return noExt.startsWith(".") ? noExt : `./${noExt}`;
}

/** Build the export entries for a set of fetched module files. Pure. */
export function exportsEntries(
  files: readonly { path: string; content: string }[],
  aliasMap: Record<string, string>,
): ModuleExportsEntry[] {
  return files.map((f) => {
    const e = extractExportedNames(f.content);
    return { specifier: toImportSpecifier(f.path, aliasMap), names: [...e.names], hasDefault: e.hasDefault };
  });
}

/**
 * The author-prompt block: the exact exported symbols of the relevant modules.
 * Empty when there is nothing with exports to list. Pure.
 */
export function buildKnownExportsBlock(entries: readonly ModuleExportsEntry[]): string {
  const real = entries.filter((e) => e.names.length > 0 || e.hasDefault);
  if (real.length === 0) return "";
  const lines = real.map((e) => {
    const names = e.hasDefault ? ["default", ...e.names] : [...e.names];
    return `- ${e.specifier}: ${names.join(", ")}`;
  });
  return [
    "KNOWN EXPORTS - the exact symbols these existing modules export. When you import",
    "from one of them, use ONLY a name listed here; do NOT invent a name. An import of a",
    "symbol a module does not export fails CI and is blocked by the gate:",
    ...lines,
  ].join("\n");
}
