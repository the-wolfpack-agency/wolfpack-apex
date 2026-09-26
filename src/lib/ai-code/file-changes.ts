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

/** Confine a path to the repo (no traversal / absolute), same rule as the sandbox. */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  const norm = path.replace(/\\/g, "/");
  return !norm.split("/").includes("..");
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
  }
  await createBranch(input.client, input.repoFullName, input.branch, input.base);
  const committed: string[] = [];
  for (const c of input.changes) {
    await putFile(input.client, input.repoFullName, c.path, c.content, `${input.message} (${c.path})`, input.branch);
    committed.push(c.path);
  }
  return committed;
}
