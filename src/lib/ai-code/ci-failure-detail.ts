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
const ERROR_LINE = /(?:^|[^\w])(FAIL |✕|✘|●|error TS\d|Type error|Expected|Received|Error:|Cannot\b|not found|Module not found|assert|exit code [1-9]|Tests:\s)/i;

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

/** Gather the real failure detail + the files it references for a commit's CI.
 *  Never throws: any failure yields empty context, so the fixer degrades to the
 *  thin brief rather than erroring. */
export async function gatherFailureContext(
  client: GithubClient,
  repoFullName: string,
  sha: string,
  ref: string,
  maxDetailChars = 6000,
): Promise<FailureContext> {
  try {
    const runs = await listWorkflowRunsRaw(client, repoFullName, sha);
    const failedRuns = runs.filter((r) => r.conclusion === "failure").slice(0, 3);
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
    const files: { path: string; content: string }[] = [];
    // Fetch the files the error names AND the source behind any failing test, so
    // the re-author can fix the SOURCE (the error only names the test file).
    for (const path of withSourcePaths(extractFilePaths(detail))) {
      const content = await fetchFileContent(client, repoFullName, path, ref).catch(() => null);
      if (content) files.push({ path, content: content.slice(0, 6000) });
    }
    return { detail, files };
  } catch {
    return { detail: "", files: [] };
  }
}

/** Build the enriched re-author prompt from the thin brief + the real failure
 *  context. Pure. Instructs the model to fix the SOURCE, never weaken tests. */
export function buildEnrichedFixPrompt(args: {
  repo: string;
  branch: string;
  brief: string;
  context: FailureContext;
}): string {
  const fileBlocks = args.context.files
    .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return [
    `The pull request on branch ${args.branch} of ${args.repo} is failing CI.`,
    args.brief,
    args.context.detail ? `The ACTUAL CI failure:\n${args.context.detail}` : "",
    fileBlocks ? `Current contents of the files involved:\n\n${fileBlocks}` : "",
    "Author the FULL corrected file contents that make the failing checks pass. Fix the SOURCE that is wrong; do NOT weaken, delete, or trivially satisfy any test or gate.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
