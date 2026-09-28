/**
 * Gather the ACTUAL failure detail for a failing CI run, so the CI-fixer can
 * author a real fix instead of guessing from a check name.
 *
 * Found by dogfooding: the fixer read the failing checks but re-authored nothing
 * ("empty"), because all it had was a workflow NAME (via the Actions read) - no
 * error text, no file context. This pulls the failing job's log, extracts the
 * error lines, and fetches the files the error points at, so the re-author is
 * given exactly what a human would look at.
 *
 * The parsers are pure (testable without GitHub); gatherFailureContext does the
 * IO and never throws (best-effort context, not a gate).
 */
import {
  listWorkflowRunsRaw,
  listRunJobs,
  fetchJobLogText,
  fetchFileContent,
  type GithubClient,
} from "@/lib/github-client";

const TS_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/;
const ERROR_LINE = /(?:^|[^\w])(FAIL |✕|✘|●|error TS\d|Type error|Expected|Received|Error:|Cannot\b|not found|Module not found|assert|exit code [1-9]|Tests:\s|must contain at least one test|No tests found|Test suite failed to run|npm ERR!|error \w+\(|does not (?:exist|satisfy)|Parsing error)/i;

/** Pull the error-relevant lines out of a raw job log: strip the ISO timestamp
 *  each Actions log line carries, keep the lines that describe a failure, cap the
 *  volume. Pure. */
export function extractErrorLines(log: string, maxLines = 50): string {
  const out: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(TS_PREFIX, "").replace(/\r$/, "").trimEnd();
    if (line === "") continue;
    if (ERROR_LINE.test(line)) {
      out.push(line);
      if (out.length >= maxLines) break;
    }
  }
  return out.join("\n");
}

const FILE_PATH = /(?:src|tests|app|lib|pages|components)\/[\w./-]+\.(?:tsx?|jsx?)/g;

/** The TEST files named as FAILING in a jest/CI log (the "FAIL <path>" lines).
 *  Used to detect non-progress on a test THIS change authored. Pure: deduped,
 *  order preserved. */
export function extractFailingTestFiles(text: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // "FAIL src/lib/__tests__/x.test.ts" (optionally after a stripped timestamp).
  for (const m of text.matchAll(/(?:^|\s)FAIL\s+((?:src|tests|app|lib|pages|components)\/[\w./-]+\.(?:tsx?|jsx?))/g)) {
    const p = m[1];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** A failing jest error names the TEST file, not the source under test. To fix
 *  the source (never the test), derive the likely source path(s) from a test
 *  path: drop the `__tests__/` segment and the `.test`/`.spec` suffix. Returns []
 *  for a non-test path. Pure. */
export function deriveSourcePaths(testPath: string): string[] {
  const out: string[] = [];
  // src/lib/__tests__/readingTime.test.ts -> src/lib/readingTime.ts
  const withDir = testPath.match(/^(.*?)__tests__\/(.+)\.(?:test|spec)\.(tsx?|jsx?)$/);
  if (withDir) out.push(`${withDir[1]}${withDir[2]}.${withDir[3]}`);
  // src/x.test.ts -> src/x.ts (same-dir convention)
  const sameDir = testPath.match(/^(.+)\.(?:test|spec)\.(tsx?|jsx?)$/);
  if (sameDir) out.push(`${sameDir[1]}.${sameDir[2]}`);
  return [...new Set(out)].filter((p) => p !== testPath);
}

/** Expand a list of failing files with the SOURCE files behind any test files,
 *  so the re-author sees the code it must fix (not just the test). Pure. */
export function withSourcePaths(paths: readonly string[], max = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!seen.has(p) && out.length < max) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const p of paths) {
    add(p);
    for (const src of deriveSourcePaths(p)) add(src);
  }
  return out;
}

/** Source file paths referenced in the failure text, so we can fetch them for
 *  the re-author. Pure: deduped, capped, order preserved. */
export function extractFilePaths(text: string, max = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(FILE_PATH)) {
    const p = m[0];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

export interface FailureContext {
  /** The extracted error text (what actually failed). "" when unavailable. */
  detail: string;
  /** The files the error points at, with their current contents. */
  files: { path: string; content: string }[];
}

/** True when the fixer has SOMETHING to anchor a fix to: real failure detail,
 *  file contents, or the change's known file list. With none of these, authoring
 *  is blind - the model invents a wrong-path file (dogfooding: it wrote
 *  src/lib/utils/deepMerge.js). The route uses this to refuse rather than guess. */
export function hasFixAnchor(context: FailureContext, changedFiles: readonly string[]): boolean {
  return Boolean(context.detail) || context.files.length > 0 || changedFiles.length > 0;
}

/** Post-author anti-hallucination guard. When this change's files are known, a
 *  fix that edits NONE of them and only produces new paths is the hallucination
 *  caught by dogfooding (a parallel src/lib/utils/deepMerge.js instead of editing
 *  the real src/lib/deepMerge.ts). Reject it (escalate) rather than commit a
 *  parallel file. A fix that edits at least one real changed file is trusted
 *  as-is (it may legitimately add a helper alongside). Pure. */
export function guardAuthoredFix<T extends { path: string }>(args: {
  changes: readonly T[];
  authorError: string | null;
  changedFiles: readonly string[];
}): { changes: T[]; error: string | null } {
  if (args.authorError) return { changes: [], error: args.authorError };
  const changed = new Set(args.changedFiles);
  const touchesChange = args.changes.some((c) => changed.has(c.path));
  if (args.changedFiles.length > 0 && args.changes.length > 0 && !touchesChange) {
    return {
      changes: [],
      error: `re-author edited none of this change's files and only produced new paths (${args.changes
        .map((c) => c.path)
        .join(", ")}); refusing to commit a parallel file`,
    };
  }
  return { changes: [...args.changes], error: null };
}

/** Gather the real failure detail + the files it references for a commit's CI.
 *  Never throws: any failure yields empty context, so the fixer degrades to the
 *  thin brief rather than erroring. */
export async function gatherFailureContext(
  client: GithubClient,
  repoFullName: string,
  sha: string,
  ref: string,
  opts: { onlyRunNames?: string[]; maxDetailChars?: number } = {},
): Promise<FailureContext> {
  const maxDetailChars = opts.maxDetailChars ?? 6000;
  try {
    const runs = await listWorkflowRunsRaw(client, repoFullName, sha);
    // Scope to the INTRODUCED runs when we know them, so the fixer is never asked
    // to repair a pre-existing failure it did not cause (e.g. a broken e2e suite).
    const only = opts.onlyRunNames && opts.onlyRunNames.length > 0 ? new Set(opts.onlyRunNames) : null;
    const failedRuns = runs
      .filter((r) => r.conclusion === "failure" && (!only || only.has(r.name)))
      .slice(0, 3);
    const parts: string[] = [];
    for (const run of failedRuns) {
      let jobs: Awaited<ReturnType<typeof listRunJobs>> = [];
      try {
        jobs = (await listRunJobs(client, repoFullName, run.id)).filter((j) => j.conclusion === "failure");
      } catch {
        jobs = [];
      }
      for (const job of jobs.slice(0, 2)) {
        try {
          const err = extractErrorLines(await fetchJobLogText(client, repoFullName, job.id));
          if (err) parts.push(`### ${run.name} / ${job.name}\n${err}`);
        } catch {
          /* skip a job whose log is unavailable */
        }
      }
    }
    const detail = parts.join("\n\n").slice(0, maxDetailChars);
    // Fetch the files the error names AND the source behind any failing test, so
    // the re-author can fix the SOURCE (the error only names the test file).
    const files = await fetchFilesContent(client, repoFullName, withSourcePaths(extractFilePaths(detail)), ref);
    return { detail, files };
  } catch {
    return { detail: "", files: [] };
  }
}

/** Fetch the current contents of a set of paths at a ref, capped per file and in
 *  count, skipping any that 404. Shared by the failure-context gatherer and the
 *  route's changed-file anchor fallback so both fetch identically. Never throws. */
export async function fetchFilesContent(
  client: GithubClient,
  repoFullName: string,
  paths: readonly string[],
  ref: string,
  opts: { maxFiles?: number; maxCharsPerFile?: number } = {},
): Promise<{ path: string; content: string }[]> {
  const maxFiles = opts.maxFiles ?? 6;
  const maxChars = opts.maxCharsPerFile ?? 6000;
  const out: { path: string; content: string }[] = [];
  for (const path of paths) {
    if (out.length >= maxFiles) break;
    const content = await fetchFileContent(client, repoFullName, path, ref).catch(() => null);
    if (content) out.push({ path, content: content.slice(0, maxChars) });
  }
  return out;
}

/** Build the enriched re-author prompt from the thin brief + the real failure
 *  context. Pure. Instructs the model to fix WHICHEVER side is wrong (source or a
 *  wrong test expectation), so the loop converges to green instead of looping or
 *  escalating. `authoredTestStillFailing` names the change's own test files that
 *  are STILL failing after a prior fix - a strong signal the test's expected
 *  value is the wrong one. */
const SUBTYPE_HINT: Record<string, string> = {
  type: "This is a TYPE error. Fix the type mismatch itself (add/correct a type, a generic, or a narrow) - do not cast to any or weaken types to silence it.",
  import: "This is an IMPORT / module-resolution error. Add or correct the import (right path, named vs default, install-free); do not stub the module.",
  lint: "This is a LINT / formatting issue. Apply the mechanical fix (unused vars, quotes, semicolons, spacing) without changing behavior.",
  build: "This is a BUILD/compile error. Fix the compile error at its source.",
};

export function buildEnrichedFixPrompt(args: {
  repo: string;
  branch: string;
  brief: string;
  context: FailureContext;
  authoredTestStillFailing?: string[];
  subtype?: string;
  /** The files this change actually consists of (the PR's diff vs base). The
   *  authoritative anchor: the fix must edit THESE files. Prevents the fixer,
   *  when it has thin/empty failure context, from hallucinating a brand-new file
   *  at an invented path/extension (dogfooding found it authored
   *  `src/lib/utils/deepMerge.js` instead of editing the real
   *  `src/lib/deepMerge.ts`). */
  changedFiles?: readonly string[];
}): string {
  const subtypeHint = args.subtype ? SUBTYPE_HINT[args.subtype] : undefined;
  const fileBlocks = args.context.files
    .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  const stalled = args.authoredTestStillFailing && args.authoredTestStillFailing.length > 0;
  const changed = args.changedFiles && args.changedFiles.length > 0 ? args.changedFiles : undefined;
  return [
    `The pull request on branch ${args.branch} of ${args.repo} is failing CI.`,
    args.brief,
    args.context.detail ? `The ACTUAL CI failure:\n${args.context.detail}` : "",
    subtypeHint ?? "",
    changed
      ? `This change consists of EXACTLY these file(s): ${changed.join(", ")}. Fix the failure by editing the EXISTING file(s) listed here. Do NOT create a new file at a different path or with a different extension (for example, do not add a parallel .js file for a .ts module, and do not invent a new directory) - the module under test already exists in this list, so modify it in place.`
      : "",
    fileBlocks ? `Current contents of the files involved:\n\n${fileBlocks}` : "",
    stalled
      ? `A fix was already attempted and these test file(s) this change authored are STILL failing: ${args.authoredTestStillFailing!.join(", ")}. When the source correctly implements the described behavior, that means the TEST's expected value is wrong - correct the expected value(s) to match the source's correct output (each failing assertion shows "Expected" vs "Received"; "Received" is the source's actual result).`
      : "",
    'Author the FULL corrected file contents that make the failing checks pass. Determine which side is wrong from the failure (every assertion shows "Expected" vs "Received"): if the SOURCE does not implement the described behavior, fix the source; if the source is correct and a TEST asserts a value that contradicts the source\'s correct output, correct that test\'s expected value. Never delete, disable, skip, or otherwise weaken a test or reduce its coverage - only correct a demonstrably wrong expected value. A human reviews and merges the result.',
  ]
    .filter(Boolean)
    .join("\n\n");
}
