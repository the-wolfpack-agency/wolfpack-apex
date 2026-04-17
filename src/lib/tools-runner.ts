/**
 * Tools Runner — GitHub Actions integration for Instinct tools.
 *
 * Instead of running Python locally (child_process), tools now:
 *   1. Trigger a workflow_dispatch on the tools-runner.yml workflow
 *   2. Poll the run status until completion
 *   3. Download the result artifact (result.json) from the completed run
 *
 * The GITHUB_TOKEN_TOOLS env var must be set in Vercel with a fine-grained
 * PAT that has actions:write + actions:read on the repo.
 *
 * SECURITY: This module is server-only. Never import from "use client" components.
 */

const REPO = "the-wolfpack-agency/wolfpack-apex";
const WORKFLOW_FILE = "tools-runner.yml";
const GITHUB_API = "https://api.github.com";

export type ToolName = "pdf-report" | "demo-deck" | "visual-diff" | "accessibility";

export interface ToolRunStatus {
  status: "queued" | "running" | "completed" | "failed" | "not_configured";
  run_id?: number;
  artifact_url?: string;
  result?: Record<string, unknown>;
  error?: string;
  elapsed_ms?: number;
  created_at?: string;
}

interface TriggerOpts {
  target_url?: string;
  paths?: string;
  requester?: string;
}

/* ── Internal fetch helper ─────────────────────────────────────────── */

async function ghApi<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "wolfpack-instinct-tools",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ── Public API ────────────────────────────────────────────────────── */

/**
 * Trigger a tool run via workflow_dispatch. Returns immediately with the
 * estimated run_id (found by polling runs created after dispatch).
 */
export async function triggerToolRun(
  tool: ToolName,
  opts: TriggerOpts,
  githubToken: string,
): Promise<{ run_id: number } | { error: string }> {
  const beforeTs = new Date().toISOString();

  // Dispatch the workflow
  await ghApi(githubToken, "POST", `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    ref: "main",
    inputs: {
      tool,
      target_url: opts.target_url ?? "https://wolfpack-instinct.vercel.app",
      paths: opts.paths ?? "/,/login,/sites,/security-posture",
      requester: opts.requester ?? "",
    },
  });

  // GitHub doesn't return the run_id from dispatch. Poll to find the new run.
  // Subtract 30s from beforeTs to handle clock drift between our server and GitHub.
  const beforeDate = new Date(new Date(beforeTs).getTime() - 30_000);
  await new Promise((r) => setTimeout(r, 3000));

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const runs = await ghApi<{ workflow_runs: Array<{ id: number; created_at: string; event: string }> }>(
        githubToken,
        "GET",
        `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5&event=workflow_dispatch`,
      );

      const match = runs.workflow_runs.find(
        (r) => new Date(r.created_at) >= beforeDate,
      );

      if (match) {
        return { run_id: match.id };
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Last resort: return the most recent run regardless of timestamp
  try {
    const runs = await ghApi<{ workflow_runs: Array<{ id: number }> }>(
      githubToken,
      "GET",
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1&event=workflow_dispatch`,
    );
    if (runs.workflow_runs.length > 0) {
      return { run_id: runs.workflow_runs[0].id };
    }
  } catch {
    // give up
  }

  return { error: "Workflow dispatched but run ID could not be determined. Check GitHub Actions." };
}

/**
 * Get the current status of a workflow run.
 */
export async function getRunStatus(
  run_id: number,
  githubToken: string,
): Promise<ToolRunStatus> {
  const run = await ghApi<{
    id: number;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
  }>(githubToken, "GET", `/repos/${REPO}/actions/runs/${run_id}`);

  const created = new Date(run.created_at).getTime();
  const updated = new Date(run.updated_at).getTime();

  if (run.status === "queued" || run.status === "waiting" || run.status === "pending") {
    return { status: "queued", run_id, elapsed_ms: updated - created, created_at: run.created_at };
  }

  if (run.status === "in_progress") {
    return { status: "running", run_id, elapsed_ms: Date.now() - created, created_at: run.created_at };
  }

  // Completed
  if (run.conclusion === "success") {
    return {
      status: "completed",
      run_id,
      elapsed_ms: updated - created,
      created_at: run.created_at,
    };
  }

  return {
    status: "failed",
    run_id,
    error: `Workflow concluded with: ${run.conclusion}`,
    elapsed_ms: updated - created,
    created_at: run.created_at,
  };
}

/**
 * Download and parse the result.json artifact from a completed run.
 */
export async function fetchArtifactResult(
  run_id: number,
  tool: ToolName,
  githubToken: string,
): Promise<Record<string, unknown> | null> {
  // List artifacts for the run
  const artifacts = await ghApi<{
    artifacts: Array<{ id: number; name: string; archive_download_url: string }>;
  }>(githubToken, "GET", `/repos/${REPO}/actions/runs/${run_id}/artifacts`);

  const artifactName = `tool-results-${tool}-${run_id}`;
  const match = artifacts.artifacts.find((a) => a.name === artifactName);

  if (!match) return null;

  // Download the zip artifact. GitHub returns a 302 to Azure Blob Storage.
  // We must follow the redirect manually because the Authorization header
  // gets stripped on cross-origin redirects (Node fetch security behavior),
  // and Azure needs the SAS token from the redirect URL, not our PAT.
  const redirectRes = await fetch(`${GITHUB_API}/repos/${REPO}/actions/artifacts/${match.id}/zip`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "wolfpack-instinct-tools",
    },
    redirect: "manual",
  });

  let res: Response;
  if (redirectRes.status === 302) {
    const location = redirectRes.headers.get("location");
    if (!location) return null;
    res = await fetch(location);
  } else if (redirectRes.ok) {
    res = redirectRes;
  } else {
    return null;
  }

  if (!res.ok) return null;

  try {
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const resultJson = extractJsonFromZip(bytes, "result.json");
    if (resultJson) {
      return JSON.parse(resultJson);
    }
  } catch {
    // Failed to parse artifact
  }

  return null;
}

/**
 * Get the latest completed run for a specific tool (for showing cached results).
 */
export async function getLatestToolRun(
  tool: ToolName,
  githubToken: string,
): Promise<ToolRunStatus | null> {
  try {
    const runs = await ghApi<{
      workflow_runs: Array<{
        id: number;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
      }>;
    }>(
      githubToken,
      "GET",
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=10&event=workflow_dispatch`,
    );

    // Find the latest completed run for this tool. We can't filter by input
    // directly, so we check the artifact name pattern.
    for (const run of runs.workflow_runs) {
      if (run.conclusion !== "success") continue;

      // Check if this run has the right artifact
      try {
        const artifacts = await ghApi<{
          artifacts: Array<{ name: string }>;
        }>(githubToken, "GET", `/repos/${REPO}/actions/runs/${run.id}/artifacts`);

        const hasToolArtifact = artifacts.artifacts.some(
          (a) => a.name.startsWith(`tool-results-${tool}-`),
        );

        if (hasToolArtifact) {
          return {
            status: "completed",
            run_id: run.id,
            created_at: run.created_at,
            elapsed_ms: new Date(run.updated_at).getTime() - new Date(run.created_at).getTime(),
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // GitHub API unavailable
  }

  return null;
}

/**
 * Check if the tools runner is configured (GITHUB_TOKEN_TOOLS exists).
 */
export function isConfigured(): boolean {
  return !!process.env.GITHUB_TOKEN_TOOLS;
}

/* ── ZIP extraction helper ─────────────────────────────────────────── */

/**
 * Extract a file's contents from a ZIP buffer by filename.
 * Minimal implementation — only handles stored (no compression) and deflated entries.
 * For our use case the artifacts are small JSON files.
 */
function extractJsonFromZip(zipBytes: Uint8Array, targetFilename: string): string | null {
  // Use Node.js zlib for deflate decompression (works in Vercel Functions)
  let inflateRawSync: ((buf: Uint8Array) => Buffer) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    inflateRawSync = require("zlib").inflateRawSync;
  } catch {
    // zlib not available
  }

  const decoder = new TextDecoder();
  let offset = 0;

  while (offset < zipBytes.length - 4) {
    if (
      zipBytes[offset] === 0x50 &&
      zipBytes[offset + 1] === 0x4b &&
      zipBytes[offset + 2] === 0x03 &&
      zipBytes[offset + 3] === 0x04
    ) {
      const compressionMethod = zipBytes[offset + 8] | (zipBytes[offset + 9] << 8);
      const compressedSize =
        zipBytes[offset + 18] |
        (zipBytes[offset + 19] << 8) |
        (zipBytes[offset + 20] << 16) |
        (zipBytes[offset + 21] << 24);
      const filenameLen = zipBytes[offset + 26] | (zipBytes[offset + 27] << 8);
      const extraLen = zipBytes[offset + 28] | (zipBytes[offset + 29] << 8);

      const filenameBytes = zipBytes.slice(offset + 30, offset + 30 + filenameLen);
      const filename = decoder.decode(filenameBytes);
      const dataStart = offset + 30 + filenameLen + extraLen;

      if (filename === targetFilename || filename.endsWith(`/${targetFilename}`)) {
        const raw = zipBytes.slice(dataStart, dataStart + compressedSize);
        if (compressionMethod === 0) {
          return decoder.decode(raw);
        }
        if (compressionMethod === 8 && inflateRawSync) {
          const decompressed = inflateRawSync(raw);
          return decoder.decode(decompressed);
        }
      }

      offset = dataStart + compressedSize;
    } else {
      offset++;
    }
  }

  return null;
}
