/**
 * Read-only GitHub access through the gh CLI.
 *
 * WHY THE CLI AND NOT A TOKEN IN CODE. Locally the operator is already signed
 * in with `gh auth login`; in Actions the workflow exports GH_TOKEN. Either way
 * no token passes through this file, and nothing here can write: every call is
 * a GET (`gh api` defaults to GET and we never pass -X or a body).
 *
 * Never throws. A 404 (repo has no lockfile), a 403 (Dependabot disabled, token
 * lacks a scope) and a network error are all ordinary answers for a sweep over
 * many repositories, so each comes back as a typed result for the caller to
 * report rather than an exception that would stop the sweep halfway.
 */
import { execFile } from "node:child_process";

export type GhResult<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

const MAX_BUFFER = 200 * 1024 * 1024;

/** Pull the HTTP status out of gh's stderr, e.g. "gh: Not Found (HTTP 404)". */
export function parseGhStatus(stderr: string): number | null {
  const m = /\(HTTP (\d{3})\)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: MAX_BUFFER, env: process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? err.message : "") });
    });
  });
}

/** GET one endpoint and parse JSON. */
export async function ghGet<T>(path: string, headers: string[] = []): Promise<GhResult<T>> {
  const args = ["api", path, ...headers.flatMap((h) => ["-H", h])];
  const r = await run(args);
  if (r.code !== 0) {
    return { ok: false, status: parseGhStatus(r.stderr + r.stdout), message: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  try {
    return { ok: true, data: JSON.parse(r.stdout) as T };
  } catch {
    return { ok: false, status: null, message: "response was not JSON" };
  }
}

/** GET a raw file body (contents API with the raw media type; up to 100 MB). */
export async function ghGetRaw(path: string): Promise<GhResult<string>> {
  const r = await run(["api", path, "-H", "Accept: application/vnd.github.raw"]);
  if (r.code !== 0) {
    return { ok: false, status: parseGhStatus(r.stderr + r.stdout), message: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  return { ok: true, data: r.stdout };
}

/**
 * GET every page of a list endpoint. `--slurp` returns an array of pages; list
 * endpoints that wrap their items (e.g. {total_count, workflow_runs}) are
 * unwrapped with `itemsKey`.
 */
export async function ghPaginate<T>(path: string, itemsKey?: string): Promise<GhResult<T[]>> {
  const r = await run(["api", path, "--paginate", "--slurp"]);
  if (r.code !== 0) {
    return { ok: false, status: parseGhStatus(r.stderr + r.stdout), message: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  try {
    const pages = JSON.parse(r.stdout) as unknown[];
    const out: T[] = [];
    for (const page of pages) {
      if (Array.isArray(page)) out.push(...(page as T[]));
      else if (itemsKey && page && typeof page === "object" && Array.isArray((page as Record<string, unknown>)[itemsKey])) {
        out.push(...((page as Record<string, unknown>)[itemsKey] as T[]));
      }
    }
    return { ok: true, data: out };
  } catch {
    return { ok: false, status: null, message: "paginated response was not JSON" };
  }
}

/**
 * GET a binary body (an Actions artifact zip) straight to `destFile`. gh
 * follows the 302 to the signed blob URL; stdout goes to the file, so the bytes
 * never pass through a JS string. Still a GET: no -X, no body.
 */
export function ghDownload(path: string, destFile: string): Promise<GhResult<string>> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", 'gh api "$1" > "$2"', "sh", path, destFile],
      { maxBuffer: MAX_BUFFER, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message);
          resolve({ ok: false, status: parseGhStatus(msg), message: msg.trim().slice(0, 300) });
        } else resolve({ ok: true, data: destFile });
      },
    );
  });
}
