/**
 * POST /api/agents/scan: the agent self-onboarding scan (OGIAM).
 *
 * When an agent first comes online it introspects the platform to learn how to
 * use it. This route is the agent-facing entry point: the agent presents its
 * access token (NOT a human capability gate), we confirm the token is a valid
 * agent credential AND that the agent is still active in the DB, run the
 * deterministic discovery scan, persist it, and return a small summary.
 *
 * Security posture:
 *   - The agent token is the credential. resolveAgentFromRequest verifies it;
 *     a missing / non-agent / expired token yields a generic 401.
 *   - State is re-checked against the DB, never trusted from the token: a
 *     still-valid token whose agent was revoked or paused after issuance must
 *     not be able to scan. We load the principal from the store and reject any
 *     non-active state with 403 agent_not_active (we do not distinguish revoked
 *     vs paused vs missing to the caller).
 *   - The response carries only the summary (counts + scan_version), not the
 *     full model, to stay small. The full model is read by an admin through
 *     GET /api/admin/agents/[id]/scan.
 *   - Cache-Control: no-store on every response.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveAgentFromRequest } from "@/lib/agents/identity";
import { getAgent } from "@/lib/agents/store";
import { runSelfOnboardingScan } from "@/lib/agents/scan";
import { saveScan } from "@/lib/agents/scan-store";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE } });
}

export async function POST(req: NextRequest) {
  const principal = await resolveAgentFromRequest(req.headers.get("authorization"));
  if (!principal) {
    return json({ error: "invalid_token" }, 401);
  }

  /* Re-verify state from the source of truth. A revoked or paused agent may
     still hold a non-expired token; it must not be able to scan. We treat a
     missing record the same as a non-active one and never reveal which it was. */
  const agent = await getAgent(principal.agentId, principal.workspaceId);
  if (!agent || agent.state === "revoked" || agent.state === "paused") {
    return json({ error: "agent_not_active" }, 403);
  }

  const model = runSelfOnboardingScan({
    agentId: principal.agentId,
    role: principal.role,
    workspaceId: principal.workspaceId,
  });
  await saveScan(model);

  return json(
    { ok: true, summary: model.summary, scan_version: model.scanVersion },
    200,
  );
}
