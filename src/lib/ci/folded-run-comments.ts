/**
 * Finds `#` comments inside folded `run:` scalars in GitHub workflow files.
 *
 * THE BUG THIS CATCHES (e2e-reality-check.yml, found 2026-10-25): a step was
 * written as
 *
 *   run: >-
 *     npx playwright test
 *     tests/e2e/a.spec.ts
 *     # why b is a gate
 *     tests/e2e/b.spec.ts
 *     --config=playwright.config.ts --workers=2
 *
 * Inside a block scalar a `#` line is not a YAML comment, it is content. A
 * folded scalar (`>`, `>-`, `>+`) joins its lines with spaces, so the shell
 * received ONE line, and everything after the first `#` was a shell comment:
 * five specs and every flag. The step ran two specs, stayed green, and the
 * other five had never run in CI. A YAML parser accepts the file and the
 * workflow starts, so neither workflow-yaml-parses nor workflows-can-start
 * could see it.
 *
 * Detection is textual on purpose: the parsed value no longer tells you which
 * scalar style produced it. A finding is any content line of a folded `run:`
 * scalar that starts with `#`, or that carries a whitespace-preceded `#`
 * outside quotes (an inline shell comment, which truncates the rest of the
 * folded line the same way). Literal `run: |` blocks are not checked: there
 * each line stays its own shell line and `#` comments are fine.
 *
 * Deterministic, no dependency, no network.
 */

export interface FoldedRunComment {
  /** 1-based line number in the workflow file. */
  line: number;
  /** The offending line, trimmed. */
  text: string;
}

const FOLDED_RUN = /^(\s*)(?:-\s+)?run:\s*>(?:[-+]?\d*|\d+[-+])\s*(?:#.*)?$/;

/** True when `line` has a shell comment start outside single/double quotes. */
function hasShellComment(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("#")) return true;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "#" && /\s/.test(t[i - 1] ?? "")) return true;
  }
  return false;
}

export function findFoldedRunComments(text: string): FoldedRunComment[] {
  const lines = text.split("\n");
  const findings: FoldedRunComment[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!FOLDED_RUN.test(lines[i])) continue;
    /* The key's column: for "- run:" the key sits after the dash. */
    const keyIndent = lines[i].indexOf("run:");
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= keyIndent) break; // scalar ended
      if (hasShellComment(line)) findings.push({ line: j + 1, text: line.trim() });
    }
  }
  return findings;
}
