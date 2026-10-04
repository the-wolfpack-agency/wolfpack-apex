/**
 * The ONE data seam for Factory Chat. Everything the chat needs goes through here,
 * against the existing endpoints, so the standalone repo extraction only has to
 * repoint FACTORY_API_BASE. Auth is the shared refresh-aware fetch (never raw fetch).
 */
import { fetchWithRefresh } from "@/lib/client-auth";
import type { PipelineResult, CiDashboardLite } from "./types";

/** Same-origin in the Instinct app; set to the factory host in the standalone repo. */
export const FACTORY_API_BASE = "";
const JSON_HEADERS = { "Content-Type": "application/json" };

export interface RunInput { prompt: string; repo?: string; ref?: string }
export interface RunOutcome {
  ok: boolean;
  status: number;
  result: PipelineResult;
  approvalId?: string | null;
  model?: { name: string; escalated: boolean };
  error?: string;
  /** The prompt was not a change request (intent gate). Render as a gentle nudge. */
  notARequest?: boolean;
}

export async function requestPipelineRun(input: RunInput): Promise<RunOutcome> {
  const res = await fetchWithRefresh(`${FACTORY_API_BASE}/api/admin/ai-code/pipeline`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ref: input.ref?.trim() || "factory", repo: input.repo?.trim() || undefined, prompt: input.prompt.trim() }),
  });
  const body = (await res.json().catch(() => ({}))) as PipelineResult & { approvalId?: string | null; executorAttempts?: number; error?: string; notARequest?: boolean };
  const author = body.executor?.author ?? "";
  return {
    ok: res.ok,
    status: res.status,
    result: body,
    approvalId: body.approvalId ?? null,
    model: author ? { name: author, escalated: (body.executorAttempts ?? 1) > 1 } : undefined,
    error: res.ok ? undefined : body.error || `The factory responded ${res.status}.`,
    notARequest: body.notARequest === true,
  };
}

export interface ApproveOutcome {
  ok: boolean;
  validating: boolean;
  prUrl?: string;
  branch?: string;
  compareUrl?: string;
  needsInstall?: boolean;
  error?: string;
}

export async function approveHandoff(approvalId: string): Promise<ApproveOutcome> {
  const res = await fetchWithRefresh(`${FACTORY_API_BASE}/api/admin/agents/approvals/${approvalId}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action: "approve" }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    status?: string; outcome?: { ok?: boolean; url?: string; branch?: string; compareUrl?: string; needsInstall?: boolean; reason?: string }; error?: string;
  };
  if (res.status === 202 || body.status === "validating") return { ok: false, validating: true };
  if (res.ok && body.outcome?.ok && body.outcome.url) {
    return { ok: true, validating: false, prUrl: body.outcome.url, branch: body.outcome.branch };
  }
  return { ok: false, validating: false, error: body.outcome?.reason || body.error || "Approval did not open a PR.", compareUrl: body.outcome?.compareUrl, needsInstall: body.outcome?.needsInstall };
}

export async function loadCi(repo: string, ref: string): Promise<CiDashboardLite | null> {
  try {
    const res = await fetchWithRefresh(`${FACTORY_API_BASE}/api/admin/ai-code/ci?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { dashboard?: CiDashboardLite };
    return body.dashboard ?? null;
  } catch {
    return null;
  }
}
