/**
 * Static source scan: read a target repo's files and run the line-based
 * detectors over each, aggregating into a PlatformScanResult. readFile is
 * INJECTED so the scan is decoupled from GitHub (tests pass a stub; production
 * passes defaultReadFile). The result shape is identical to the HTTP and
 * (future) browser-journey modalities so all three feed the same store.
 */

import type { PlatformScanResult, ScanFinding } from "@/lib/platform-scan/types";
import { runDetectors } from "@/lib/platform-scan/static/detectors";

export interface ScanSourceInput {
  platform: string;
  owner: string;
  repo: string;
  ref?: string;
  paths: string[];
  /** Injected: returns file content, or null if the file is missing/unreadable. */
  readFile: (path: string) => Promise<string | null>;
}

export async function scanSource(input: ScanSourceInput): Promise<PlatformScanResult> {
  const { platform, owner, repo, paths, readFile } = input;

  const findings: ScanFinding[] = [];
  let okCount = 0;

  for (const path of paths) {
    const content = await readFile(path);
    if (content == null) continue;

    const fileFindings = runDetectors({ path, content });
    if (fileFindings.length === 0) {
      okCount++;
    } else {
      findings.push(...fileFindings);
    }
  }

  return {
    platform,
    baseUrl: `github:${owner}/${repo}`,
    routeCount: paths.length,
    okCount,
    findings,
    // Every analyzed file is "covered", letting recordScan auto-resolve findings on
    // these files that the detectors no longer flag (matches ScanFinding.route = file path).
    scannedRoutes: paths,
  };
}

/**
 * Production readFile: fetch a single file via the GitHub Contents API with the
 * raw media type. The Contents API honors Bearer auth for BOTH public and
 * private repos, so a private CLIENT repo's files are readable — unlike
 * raw.githubusercontent.com, which ignores the Authorization header on private
 * content and would silently 404 every file (a blank scan in prod). Token comes
 * from GITHUB_TOKEN_WOLFPACK_AGENCY. Returns the file text, or null on any
 * non-200 / network error. Never throws — a missing file is a normal outcome of
 * scanning a path list.
 */
export function defaultReadFile(
  owner: string,
  repo: string,
  ref?: string,
): (path: string) => Promise<string | null> {
  const branch = ref ?? "main";
  const token = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;

  return async (path: string): Promise<string | null> => {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(url, { headers });
      if (res.status !== 200) return null;
      return await res.text();
    } catch {
      return null;
    }
  };
}
