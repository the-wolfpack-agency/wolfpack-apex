/**
 * Full-file changes: the executor emits the COMPLETE content of each changed
 * file, and we commit each via the GitHub Contents API (create or update). This
 * is the edit-support path that needs no patch-applier and no local checkout -
 * the "CI is the runner" design. A modified file is just a putFile with its full
 * new content; CI then runs the real suite on the result.
 *
 * Pure parser + a thin commit over the existing github client (DRY: reuse
 * putFile/createBranch, do not reinvent git).
 */
import { createBranch, putFile, type GithubClient } from "@/lib/github-client";

export interface FileChange {
  path: string;
  content: string;
}

/**
 * Parse the executor's full-file output. The format is, per changed file:
 *
 *   FILE: <path>
 *   ```<optional lang>
 *   <full file content>
 *   ```
 *
 * Fenced so content that contains "FILE:" lines does not confuse the parser.
 * Returns [] when nothing matches (the gate then rejects an empty change).
 */
export function parseFileChanges(reply: string): FileChange[] {
  const out: FileChange[] = [];
  const re = /FILE:[ \t]*(.+?)[ \t]*\r?\n```[^\n]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const path = m[1].trim();
    // Preserve content exactly except a single trailing newline the fence adds.
    const content = m[2].replace(/\r?\n$/, "");
    if (path) out.push({ path, content });
  }
  return out;
}

/**
 * Synthesize a review diff from full-file changes so the diff-native gate, deep
 * scan, and reviewer can run on full-file content without a base. Each file is
 * rendered as an added-content block (a modified file is reviewed as its whole
 * new content - conservative and safe: it reviews everything, never less). The
 * dependency invariant is NOT derivable from this (a full file shows every dep as
 * "added"), so callers in full-file mode skip that signal rather than over-flag.
 */
export function filesToDiff(changes: readonly FileChange[]): string {
  return changes
    .map((c) => {
      const lines = c.content.split("\n");
      return [
        `diff --git a/${c.path} b/${c.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${c.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => "+" + l),
      ].join("\n");
    })
    .join("\n");
}

/** Confine a path to the repo (no traversal / absolute), same rule as the sandbox. */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  const norm = path.replace(/\\/g, "/");
  return !norm.split("/").includes("..");
}

/**
 * A VCS merge-conflict marker at the start of a line (`<<<<<<< `, `>>>>>>> `, or
 * the diff3 `||||||| `). The open/close markers are unambiguous - seven of the
 * char followed by a space or end of line - and one appearing in a source file
 * is always a broken merge, never real code. `=======` is deliberately NOT
 * matched: a bare seven-equals line is a legitimate divider in markdown/comments,
 * and the open/close markers already prove a conflict.
 */
const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?: |$)/m;

/** True when the text contains a merge-conflict marker line. Deterministic. */
export function containsConflictMarkers(text: string): boolean {
  return CONFLICT_MARKER.test(text);
}

export interface CommitFileChangesInput {
  client: GithubClient;
  repoFullName: string;
  branch: string;
  base: string;
  changes: readonly FileChange[];
  message: string;
}

/**
 * Commit a set of full-file changes to a fresh branch: create the branch, then
 * putFile each (putFile creates OR updates, so modifications and new files use
 * the identical path). Returns the paths committed. Rejects an unsafe path
 * rather than committing outside the tree.
 */
export async function commitFileChanges(input: CommitFileChangesInput): Promise<string[]> {
  for (const c of input.changes) {
    if (!isSafeRepoPath(c.path)) throw new Error(`unsafe file path: ${c.path}`);
    // Never commit a file with a merge-conflict marker. A model can emit one, or a
    // bad repair merge can leave one; committing it breaks the client's build. This
    // fails closed BEFORE any GitHub write, so the factory can never open a PR that
    // carries a conflict marker.
    if (containsConflictMarkers(c.content)) throw new Error(`conflict marker in authored file: ${c.path}`);
  }
  await createBranch(input.client, input.repoFullName, input.branch, input.base);
  const committed: string[] = [];
  for (const c of input.changes) {
    await putFile(input.client, input.repoFullName, c.path, c.content, `${input.message} (${c.path})`, input.branch);
    committed.push(c.path);
  }
  return committed;
}
