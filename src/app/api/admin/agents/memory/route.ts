/**
 * GET /api/admin/agents/memory — admin view of what the workspace's agents
 * have learned (shared procedural memory).
 *
 * Each entry is a goal plus the plan that worked, captured when an agent
 * succeeded. Entries start quarantined or get promoted/rejected by the
 * automated safety check; a human can override either way via the PATCH on
 * the [id] route. This GET is the read surface that human reviewers use to
 * decide what to promote (make inheritable) or reject (quarantine).
 *
 * Query params:
 *   status — optional, one of quarantined | promoted | rejected. Any other
 *            value is ignored (we return all statuses rather than 400, so a
 *            stray filter never blanks the review queue).
 *
 * Capability: settings.manage_team (same governance gate as the rest of the
 * admin surface — the people who manage the team govern what agents inherit).
 *
 * Workspace-scoped: only memory from the caller's workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listMemory } from "@/lib/agents/memory/store";
import type { MemoryStatus } from "@/lib/agents/memory/types";

const VALID_STATUS: ReadonlySet<MemoryStatus> = new Set([
  "quarantined",
  "promoted",
  "rejected",
]);

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";

  const raw = new URL(req.url).searchParams.get("status");
  const status =
    raw && VALID_STATUS.has(raw as MemoryStatus)
      ? (raw as MemoryStatus)
      : undefined;

  const memory = await listMemory(workspaceId, status);

  return NextResponse.json({
    workspace_id: workspaceId,
    memory,
  });
}
