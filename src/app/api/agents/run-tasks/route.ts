/**
 * POST /api/agents/run-tasks: the agent runtime.
 *
 * An active agent presents its access token and the runtime drains its queued
 * task backlog. For each queued task it claims the task (atomically flipping it
 * to running), runs it through the governed executor under the agent's own
 * identity, and persists the final state. The executor dispatches every step
 * through the OGIAM enforce gate, so authorization and the per-decision audit
 * happen inside it, not here; this endpoint only orchestrates.
 *
 * Security posture (mirrors /api/agents/act):
 *   - The agent token is the credential. resolveAgentFromRequest verifies it;
 *     a missing / non-agent / expired token yields a generic 401 invalid_token.
 *   - State is re-checked against the DB, never trusted from the token: a
 *     revoked / paused / missing agent is refused 403 agent_not_active before
 *     any task runs.
 *   - Per-agent rate limit blunts a runaway or hijacked runtime.
 *   - Bounded batch (MAX_RUN) so one call can't run unboundedly.
 *   - A thrown task is caught per-iteration so one bad task can't abort the
 *     batch or 500 the request.
 *   - Cache-Control: no-store on every response.
 *
 * No analytics here: agent.task_completed fires inside the executor for every
 * task it runs, so the learning loop already sees each completion.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveAgentFromRequest } from "@/lib/agents/identity";
import { getAgent } from "@/lib/agents/store";
import { claimNextQueuedTask } from "@/lib/agents/tasks/store";
import { executeTaskAsAgent } from "@/lib/agents/tasks/run-inline";

/* --------------------- Per-agent rate limiter ------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 6;
const attempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(
  agentId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = attempts.get(agentId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(agentId, { count: 1, windowStart: now });
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

/** Upper bound on tasks drained per call so one request can't run unbounded. */
const MAX_RUN = 5;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...(extraHeaders ?? {}) },
  });
}

interface TaskResult {
  task_id: string;
  status: string;
  steps: number;
}

export async function POST(req: NextRequest) {
  const principal = await resolveAgentFromRequest(req.headers.get("authorization"));
  if (!principal) {
    return json({ error: "invalid_token" }, 401);
  }

  /* Re-verify state from the source of truth: a revoked / paused agent must not
     run even if its token has not yet expired. Missing record is treated the
     same and not distinguished to the caller. */
  const agent = await getAgent(principal.agentId, principal.workspaceId);
  if (!agent || agent.state === "revoked" || agent.state === "paused") {
    return json({ error: "agent_not_active" }, 403);
  }

  /* Rate-limit per agent before draining the queue so a runaway runtime can't
     hammer the executor. */
  const { limited, retryAfter } = _isRateLimited(principal.agentId);
  if (limited) {
    return json({ error: "rate_limited", retryAfter }, 429, {
      "Retry-After": String(retryAfter),
    });
  }

  const results: TaskResult[] = [];

  const agentIdentity = {
    id: principal.agentId,
    role: principal.role,
    ownerUserId: principal.ownerUserId,
    workspaceId: principal.workspaceId,
  };

  for (let i = 0; i < MAX_RUN; i++) {
    const t = await claimNextQueuedTask(principal.agentId, principal.workspaceId);
    if (!t) break;

    /* Run the claimed task through the single shared inline-execution helper.
       It runs the governed executor under the agent's identity, persists the
       outcome, and best-effort marks a thrown task failed, so one bad task can
       never abort the whole drain or 500 the request. */
    const completed = await executeTaskAsAgent(agentIdentity, { id: t.id, goal: t.goal });
    results.push({
      task_id: t.id,
      status: completed?.status ?? "failed",
      steps: completed?.steps.length ?? 0,
    });
  }

  return json({ ok: true, ran: results.length, tasks: results }, 200);
}
