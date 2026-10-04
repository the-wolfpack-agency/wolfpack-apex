/**
 * Repo-aware context for the executor.
 *
 * The executor authors from the prompt alone, so it can create new files but
 * cannot reliably MODIFY existing code ("add rate limiting to src/app/api/auth/
 * login/route.ts") because it never sees the file. This gives it that context,
 * deterministically: extract the repo file paths a prompt NAMES, fetch their
 * current contents through the workspace's GitHub token, and return a compact,
 * size-capped context block to prepend to the author prompt.
 *
 * Precision over recall on purpose: it fetches only files the prompt explicitly
 * references (a real path token), never a guess. Semantic/whole-repo retrieval is
 * a later step; naming the file is the high-signal, zero-false-positive case.
 */
import type { GithubClient } from "@/lib/github-client";
import { fetchFileContent } from "@/lib/github-client";
import { isSafeRepoPath } from "./file-changes";

/** Source-file extensions worth pulling as context. */
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|sql|md|ya?ml|py|rb|go|rs|java|php|sh)$/i;
/**
 * A maximal run of path characters. ONE character class, ONE quantifier, nothing
 * after it - so the regex never backtracks and is linear on any input (safe on the
 * uncontrolled prompt; no ReDoS). The class includes `/` and `.` so a whole path
 * matches at once, and `()` / `[]` so Next.js route groups (`(dashboard)`) and
 * dynamic segments (`[id]`, `[...slug]`) are captured WHOLE - without them a path
 * like `src/app/(dashboard)/admin/page.tsx` was truncated to its tail
 * `admin/page.tsx`, which matched nothing in the repo tree (missed context fetch
 * AND missed the existing-file -> anchor redirect, so a minimal edit dead-ended at
 * a 422). The code extension is validated AFTER the match (CODE_EXT), not in the
 * regex. Found by the live large-file routing dogfood.
 */
const PATH_TOKEN = /[\w.()\[\]/-]+/g;

/** Distinct, safe, code-like paths a prompt explicitly names (order preserved). */
export function extractMentionedPaths(prompt: string, max = 5): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Defensive bound: never run the tokenizer over an unbounded prompt (the regex
  // is linear, but a hard cap keeps worst-case work constant regardless).
  const text = prompt.length > 20_000 ? prompt.slice(0, 20_000) : prompt;
  for (const m of text.matchAll(PATH_TOKEN)) {
    const p = m[0].replace(/[.\-]+$/, "");
    // Must look like a real repo path: has a slash OR a code extension, safe, unique.
    if (!CODE_EXT.test(p)) continue;
    if (!isSafeRepoPath(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export interface RepoContext {
  /** The prompt-ready context block ("" when nothing was fetched). */
  block: string;
  /** Paths actually fetched (existed and fit the budget). */
  files: string[];
}

/**
 * Build the context block for a prompt against a repo. Fetches each named path
 * that exists, newest content first, capped to maxBytes total so the prompt stays
 * bounded. NEVER throws: a fetch failure just omits that file (best-effort
 * context, not a gate).
 */
export async function buildRepoContext(args: {
  client: GithubClient;
  repo: string;
  prompt: string;
  ref?: string;
  maxBytes?: number;
  maxFiles?: number;
}): Promise<RepoContext> {
  const maxBytes = args.maxBytes ?? 24_000;
  const paths = extractMentionedPaths(args.prompt, args.maxFiles ?? 5);
  if (paths.length === 0) return { block: "", files: [] };

  const parts: string[] = [];
  const files: string[] = [];
  let used = 0;
  for (const path of paths) {
    let content: string | null = null;
    try {
      content = await fetchFileContent(args.client, args.repo, path, args.ref);
    } catch {
      content = null; // best-effort; skip on error
    }
    if (content === null) continue;
    const snippet = content.length > maxBytes ? content.slice(0, maxBytes) : content;
    if (used + snippet.length > maxBytes) break;
    used += snippet.length;
    files.push(path);
    parts.push(`FILE: ${path}\n\`\`\`\n${snippet}\n\`\`\``);
  }
  if (parts.length === 0) return { block: "", files: [] };

  const block =
    "Existing repository files referenced by the request. Modify them consistently " +
    "with what is shown; do not invent contents that contradict it.\n\n" +
    parts.join("\n\n");
  return { block, files };
}

/** Prepend a context block to a prompt (no-op when the block is empty). */
export function withRepoContext(prompt: string, block: string): string {
  return block ? `${block}\n\n---\n\nTask:\n${prompt}` : prompt;
}
