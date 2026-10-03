/**
 * Production-readiness engine - shared static-scan helpers.
 *
 * One set of repo-scanning primitives every tool's collectSignals reuses (DRY):
 * read files, count files by suffix under a dir, and test whether any file in a
 * set matches a pattern. All operate on the injected RepoReader, so they are pure
 * and the tool collectors stay hermetic under test.
 */
import type { RepoReader } from "./types";

/** Files under any of `dirs` (recursive) whose basename ends with `suffix`. */
export function filesUnder(reader: RepoReader, dirs: readonly string[], suffix?: string): string[] {
  return dirs.flatMap((d) => reader.listFiles(d, suffix));
}

/** Count of *.db.test.ts files under the given dirs (the DB-layer-test signal). */
export function dbTestCount(reader: RepoReader, dirs: readonly string[]): number {
  return filesUnder(reader, dirs, ".db.test.ts").length;
}

/** true when ANY file under `dirs` (optionally filtered by suffix) matches `re`. */
export function anyFileMatches(
  reader: RepoReader,
  dirs: readonly string[],
  re: RegExp,
  suffix?: string,
): boolean {
  for (const p of filesUnder(reader, dirs, suffix)) {
    const c = reader.read(p);
    if (c && reMatch(re, c)) return true;
  }
  return false;
}

/** true when a specific file exists and matches `re`. */
export function fileMatches(reader: RepoReader, path: string, re: RegExp): boolean {
  const c = reader.read(path);
  return c != null && reMatch(re, c);
}

/** A global regex is stateful (lastIndex); test on a fresh copy so repeated calls
 *  are deterministic. */
function reMatch(re: RegExp, s: string): boolean {
  return new RegExp(re.source, re.flags.replace("g", "")).test(s);
}

/**
 * Whether a Playwright e2e spec is run by a workflow on `pull_request` (so a
 * regression blocks a PR, not just a post-merge soft step). Heuristic but
 * deterministic: some workflow file references the spec path AND declares a
 * pull_request trigger. Caller passes the workflow texts.
 */
export function specGatesOnPR(workflowTexts: readonly string[], specPath: string): boolean {
  return workflowTexts.some(
    // `/^on:/m` anchors to the start of any line (the YAML trigger key), properly
    // grouped - no missing-anchor precedence trap. Plus a pull_request trigger.
    (t) => t.includes(specPath) && /^on:/m.test(t) && /pull_request/.test(t),
  );
}

/** All workflow file contents (for the e2e-gating checks). */
export function workflowTexts(reader: RepoReader): string[] {
  return reader
    .listFiles(".github/workflows")
    .filter((p) => p.endsWith(".yml") || p.endsWith(".yaml"))
    .map((p) => reader.read(p) ?? "");
}
