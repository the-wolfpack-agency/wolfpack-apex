/**
 * Paths an AUTHORED CI fix may never touch.
 *
 * The fixer is told to make CI green, and the cheapest way to make CI green is
 * to change what CI checks: weaken a test, edit a workflow, loosen the gate
 * that reviews the fix itself. Before 2026-10-24 nothing stopped that
 * (guardAuthoredFix had no deny list). A fix that needs one of these files is
 * a fix a human makes, so it escalates instead.
 *
 * Covers: tests and test config, CI workflows and repo automation, the code
 * factory's own gate, policy, judge, sandbox, merge and fixer code, the AI
 * router's policy and retention controls, migrations, and build and dependency
 * manifests.
 */
export const PROTECTED_FIX_PATHS: readonly RegExp[] = Object.freeze([
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(tests?|e2e|test-fixtures)\//,
  /^\.github\//,
  /^\.husky\//,
  /(^|\/)CODEOWNERS$/,
  /^src\/lib\/ai-code\/(gate|assess|policy|pr-gate|security-surface|judge|sandbox|auto-merge|ci-fix|ci-failure|watch|protections|protected-paths|code-screen|detect|deep-scan|missing-auth|selfhost-mode)[^/]*$/,
  /^src\/lib\/gates\//,
  /^src\/lib\/ai\/(policy|retention|residency|redaction|router|response-safety|spend-guard|budget)\.ts$/,
  /^src\/app\/api\/cron\/ai-code-watch\//,
  /^src\/db\/migrations\//,
  /^scripts\/(verify|db-test|security)[^/]*$/,
  /^(jest|playwright[^/]*|eslint|vitest)\.config\.[cm]?[jt]s$/,
  /^jest\.(resolver|transform)\.cjs$/,
  /^(package\.json|package-lock\.json|vercel\.json|tsconfig\.json)$/,
]);

/** Normalize a repo path: forward slashes, no leading "./" or "/". */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

export function isProtectedFixPath(path: string): boolean {
  const p = normalizePath(path);
  return PROTECTED_FIX_PATHS.some((re) => re.test(p));
}

/** The protected paths among a fix's changes, in order, deduplicated. */
export function protectedPathsIn(changes: ReadonlyArray<{ path: string }>): string[] {
  return [...new Set(changes.map((c) => normalizePath(c.path)).filter(isProtectedFixPath))];
}

/**
 * The gate verdict for a fix that touches a protected path, or null when it
 * touches none. Used by ci-fix-runner's gate before any scan runs, so the
 * refusal rule lives beside the list it reads.
 */
export function protectedPathVerdict(
  changes: ReadonlyArray<{ path: string }>,
): { cleared: false; blockedBy: string; paths: string[] } | null {
  const paths = protectedPathsIn(changes);
  if (paths.length === 0) return null;
  return { cleared: false, blockedBy: `protected_path:${paths.slice(0, 5).join(",")}`, paths };
}
