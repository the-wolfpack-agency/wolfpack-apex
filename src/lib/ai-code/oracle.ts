/**
 * The capability oracle: turn an authored diff into runnable files and EXECUTE
 * its tests in the sandbox. This is the "did the model actually do the task"
 * standard the capability ladder escalates on - distinct from the security gate.
 *
 * Scoped to greenfield (new-file) tasks for the first proof: the executor is
 * asked to CREATE a file, so the diff's new-file post-image is the whole
 * solution. The graded test is supplied by us (never by the model), and the
 * model may not touch it - detectOracleGaming enforces that upstream in the
 * ladder. Passing means the graded test ran green in the sandbox.
 */
import { runInSandbox } from "./sandbox";
import type { RunOracle } from "./capability-ladder";

/**
 * Extract the full post-image of NEW files from a unified diff (created files:
 * `--- /dev/null` -> `+++ b/<path>`). Returns {} when the diff creates none.
 * Modification hunks are ignored on purpose - a greenfield task creates files.
 */
export function newFilesFromDiff(diff: string): Record<string, string> {
  const files: Record<string, string> = {};
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) { i++; continue; }
    // Scan this file section's header.
    let isNew = false;
    let path = "";
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith("diff --git"); j++) {
      if (lines[j].startsWith("--- /dev/null")) isNew = true;
      const m = /^\+\+\+ b\/(.+)$/.exec(lines[j]);
      if (m) { path = m[1].trim(); }
      if (lines[j].startsWith("@@")) break; // body starts after the first hunk header
    }
    if (isNew && path) {
      // Collect the added lines of the body until the next file section.
      const body: string[] = [];
      let k = j + 1;
      for (; k < lines.length && !lines[k].startsWith("diff --git"); k++) {
        const l = lines[k];
        if (l.startsWith("@@")) continue;
        if (l.startsWith("+")) body.push(l.slice(1));
        // context/removed lines don't occur in a pure new file; ignore if present
      }
      files[path] = body.join("\n");
      i = k;
      continue;
    }
    i = j;
  }
  return files;
}

/**
 * Build a RunOracle that materializes the diff's new files plus a fixed set of
 * graded test files, runs `command` in the sandbox, and passes iff it exits 0.
 * The graded tests are ours and are written AFTER the model's files, so a model
 * cannot overwrite them from inside its diff.
 */
export function makeSandboxOracle(gradedFiles: Record<string, string>, command: readonly string[], timeoutMs?: number): RunOracle {
  const gradedPaths = new Set(Object.keys(gradedFiles));
  return async (diff) => {
    const authored = newFilesFromDiff(diff);
    if (Object.keys(authored).length === 0) return { passed: false, detail: "diff created no new files to execute" };
    // Model files first, graded files last so the exam paper always wins.
    const modelFiles = Object.fromEntries(Object.entries(authored).filter(([p]) => !gradedPaths.has(p)));
    const res = await runInSandbox({ files: { ...modelFiles, ...gradedFiles }, command, timeoutMs });
    if (res.passed) return { passed: true, detail: `tests passed in ${res.durationMs}ms` };
    const why = res.error || (res.timedOut ? "timed out" : res.stderr || res.stdout || `exit ${res.exitCode}`);
    return { passed: false, detail: why.replace(/\s+/g, " ").trim().slice(0, 200) };
  };
}
