/**
 * Repo grounding for code generation.
 *
 * Work back from failure: the factory generated a page + API route that imported
 * Instinct helpers (recordAudit, requireCapability, fetchWithRefresh) which do
 * not exist in the target repo, and a test using a library that was not
 * installed. The build failed and it looked like the tool wrote broken code.
 *
 * The cause: the author saw only the prompt, never the repo's real shape. This
 * gives it that shape - the framework, the modules that actually exist, the test
 * convention, the installed deps - so it reuses what is there or writes
 * self-contained code, and never invents an import.
 *
 * buildGroundingBlock is pure over (tree, package.json) so it is fully testable;
 * fetchRepoGrounding gathers those with the workspace token, best-effort.
 */
import { fetchRepoTree, fetchFileContent, type GithubClient } from "@/lib/github-client";

const CODE_MODULE = /^(?:src\/)?(?:lib|utils|helpers)\/[^/]+\.(?:tsx?|jsx?|mjs|cjs)$/;

function parseDeps(packageJsonRaw: string | null): Set<string> {
  if (!packageJsonRaw) return new Set();
  try {
    const pkg = JSON.parse(packageJsonRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

/**
 * Build the grounding block from the repo's file tree and its package.json.
 * Pure: same inputs, same block. Empty string when there is nothing to say.
 */
export function buildGroundingBlock(paths: readonly string[], packageJsonRaw: string | null): string {
  if (paths.length === 0 && !packageJsonRaw) return "";
  const deps = parseDeps(packageJsonRaw);
  const lines: string[] = ["Repository grounding (generate code that fits THIS repo; do not invent):"];

  // Framework + router shape (so a file lands where the framework expects it).
  const framework = deps.has("next") ? "Next.js" : deps.has("react") ? "React" : null;
  const hasPagesApi = paths.some((p) => /^(?:src\/)?pages\/api\//.test(p));
  const hasAppRouter = paths.some((p) => /^(?:src\/)?app\//.test(p));
  if (framework === "Next.js") {
    const router = hasAppRouter && hasPagesApi ? "app + pages" : hasAppRouter ? "app" : hasPagesApi ? "pages" : "unknown";
    lines.push(`- Framework: Next.js (router: ${router}). Every file under pages/ is a route, so never place a test or helper there.`);
  } else if (framework) {
    lines.push(`- Framework: ${framework}.`);
  }

  // The modules that actually exist, so the author imports these instead of
  // guessing helper paths (the exact failure this closes).
  const libModules = paths.filter((p) => CODE_MODULE.test(p)).slice(0, 40);
  if (libModules.length) {
    lines.push(`- Reusable modules that EXIST in this repo (import from these; do NOT import helpers that are not listed): ${libModules.join(", ")}.`);
  } else {
    lines.push("- No shared lib/ helpers were found: write self-contained code and do NOT import project-specific helpers.");
  }

  // Test convention: where tests live, which runner, and which test libraries are
  // actually installed (so it never writes a test importing an absent library).
  const testDirs = Array.from(
    new Set(paths.filter((p) => /(?:^|\/)__tests__\//.test(p)).map((p) => p.replace(/__tests__\/.*$/, "__tests__"))),
  ).slice(0, 6);
  const runner = deps.has("vitest") ? "vitest" : deps.has("jest") ? "jest" : deps.has("mocha") ? "mocha" : null;
  if (runner) {
    const parts = [`- Unit tests run with ${runner}.`];
    if (testDirs.length) parts.push(`Place new tests in a __tests__ directory (existing: ${testDirs.join(", ")}).`);
    if (!deps.has("@testing-library/react") && !deps.has("@testing-library/dom")) {
      parts.push("React Testing Library is NOT installed: do not write component-render tests; test pure logic and API handlers instead.");
    }
    if (deps.has("@playwright/test") || deps.has("playwright")) parts.push("End-to-end tests use Playwright.");
    lines.push(parts.join(" "));
  } else {
    lines.push("- No unit-test runner is installed; do not add tests that require one.");
  }

  lines.push("- Import ONLY packages listed in package.json or files that exist in this repo. Never import a module that is not present.");
  return lines.join("\n");
}

/** Grounding is a repo-structure fact that barely changes between runs, but a
 *  recursive tree + package.json fetch runs on EVERY factory run. Cache the built
 *  block per (repo, ref) for a few minutes so repeated runs against the same repo
 *  do not refetch the whole tree. In-memory (per warm serverless instance); the
 *  block is non-sensitive (public repo structure). */
const GROUNDING_TTL_MS = 5 * 60 * 1000;
const groundingCache = new Map<string, { block: string; at: number }>();

/** Clear the grounding cache (tests). */
export function __clearGroundingCache(): void {
  groundingCache.clear();
}

/** Fetch the repo tree + package.json and build the grounding block, cached per
 *  (repo, ref) for a few minutes. Never throws: any failure yields "" so
 *  authoring falls back to prompt-only. */
export async function fetchRepoGrounding(client: GithubClient, repo: string, ref?: string): Promise<string> {
  const key = `${repo}@${ref ?? "default"}`;
  const hit = groundingCache.get(key);
  if (hit && Date.now() - hit.at < GROUNDING_TTL_MS) return hit.block;
  try {
    const [paths, pkg] = await Promise.all([
      fetchRepoTree(client, repo, ref),
      fetchFileContent(client, repo, "package.json", ref).catch(() => null),
    ]);
    const block = buildGroundingBlock(paths, pkg);
    groundingCache.set(key, { block, at: Date.now() });
    return block;
  } catch {
    return "";
  }
}
