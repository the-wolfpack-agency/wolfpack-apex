/**
 * /api/workspace — update workspace display name.
 *
 * PUT /api/workspace
 *   Upserts the workspace name and ensures the caller exists as an active
 *   team member (which satisfies the profile-complete check in the status route).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import { randomUUID } from "crypto";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const raw: unknown = body?.name;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const name = raw.trim();

  if (name.length > 120) {
    return NextResponse.json({ error: "name must be 120 characters or fewer" }, { status: 400 });
  }

  /* Rename the caller's own workspace. workspaceId comes from the
     session — never from the request body — so a privileged user
     cannot rename another tenant's workspace by spoofing the id. */
  const workspaceId = user.workspaceId;

  // Capture previous workspace name for audit
  const prior = await safeQuery<{ name: string }>(
    `SELECT name FROM instinct_workspace WHERE id = $1 LIMIT 1`,
    [workspaceId],
  );
  const priorName = prior.rows[0]?.name ?? null;

  // Upsert workspace name
  const workspaceResult = await safeQuery(
    `INSERT INTO instinct_workspace (id, name, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = NOW()`,
    [workspaceId, name],
  );

  if (workspaceResult.fromCache) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  // Ensure the caller is registered as an active team member of THIS workspace.
  // Mirrors the profile-complete check in the status route.
  const memberId = `tm_${randomUUID().slice(0, 12)}`;
  await safeQuery(
    `INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, workspace_id)
     VALUES ($1, $2, $3, $4, '', true, $5)
     ON CONFLICT (email) DO UPDATE SET is_active = true`,
    [memberId, user.email, user.name, user.role, workspaceId],
  );

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "workspace.renamed",
    resourceType: "workspace",
    resourceId: workspaceId,
    beforeState: { name: priorName },
    afterState: { name },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, name });
}
