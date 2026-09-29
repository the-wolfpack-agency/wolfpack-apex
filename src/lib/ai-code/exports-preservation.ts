/**
 * Export / public-API preservation.
 *
 * Found by dogfooding the factory against a core file: while editing
 * src/lib/ogiam/policy.ts, the model rewrote the file and DROPPED the exported
 * `decide` function, breaking every module that imports it. The file still
 * PARSED, so the syntax check passed it; the break is semantic, not syntactic.
 *
 * This encodes the review step a careful engineer does by hand: "did this edit
 * keep the file's public surface?" It compares the exported symbols before and
 * after and reports any that the edit REMOVED. Removing a public export is a
 * breaking change that should stop for a human (escalate, not deny - a real
 * refactor sometimes does remove one, and a person confirms it).
 *
 * Pure and string-only, so it is fully unit tested. New files have no "before",
 * so they never flag.
 */

/** Extract the set of exported symbol names from a TS/JS source string. Covers
 *  the common forms: declaration exports, named export lists (with `as`), and
 *  default. `export * from` cannot name symbols, so it is noted as "*". Pure. */
export function extractExports(content: string): Set<string> {
  const names = new Set<string>();

  // export [async] function NAME | export class NAME | export const/let/var NAME
  // | export interface/type/enum NAME
  const declRe = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) names.add(m[1]);

  // export default ...
  if (/\bexport\s+default\b/.test(content)) names.add("default");

  // export { A, B as C, type D } [from "..."]  -> exported names are A, C, D
  const listRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
  while ((m = listRe.exec(content)) !== null) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const asMatch = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const exported = asMatch ? asMatch[1] : part.split(/\s+/)[0];
      if (exported && exported !== "*") names.add(exported);
      else if (part.startsWith("*")) names.add("*");
    }
  }

  // export * from "..."  (cannot enumerate; record as a wildcard surface)
  if (/\bexport\s+\*\s+from\b/.test(content)) names.add("*");

  return names;
}

/** Exported names present in `before` but missing from `after`: the public
 *  symbols this edit removed. Empty when nothing was removed (or `before` is
 *  empty, i.e. a new file). Pure, order-preserved. */
export function findRemovedExports(before: string, after: string): string[] {
  if (!before.trim()) return [];
  const beforeSet = extractExports(before);
  const afterSet = extractExports(after);
  const removed: string[] = [];
  for (const name of beforeSet) {
    if (!afterSet.has(name)) removed.push(name);
  }
  return removed;
}

export interface RemovedExport {
  path: string;
  name: string;
}

/** Feedback for the authoring retry: name the removed exports so the model
 *  restores them. Pure. */
export function removedExportsFeedback(removed: readonly RemovedExport[]): string {
  const byPath = new Map<string, string[]>();
  for (const r of removed) {
    const list = byPath.get(r.path) ?? [];
    list.push(r.name);
    byPath.set(r.path, list);
  }
  const lines = [...byPath.entries()].map(([path, names]) => `- ${path}: restore ${names.join(", ")}`);
  return `The edit REMOVED public export(s) that other code imports, which will break those importers:\n${lines.join("\n")}\nReturn the COMPLETE file(s) with every existing export preserved. Only remove an export if the task explicitly asked you to.`;
}
