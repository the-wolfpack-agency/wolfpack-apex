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

  // Capture previous workspace name for audit
  const prior = await safeQuery<{ name: string }>(
    `SELECT name FROM instinct_workspace WHERE id = 'default' LIMIT 1`,
  );
  const priorName = prior.rows[0]?.name ?? null;

  // Upsert workspace name
  const workspaceResult = await safeQuery(
    `INSERT INTO instinct_workspace (id, name, updated_at)
     VALUES ('default', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET name = $1, updated_at = NOW()`,
    [name],
  );

  if (workspaceResult.fromCache) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  // Ensure the caller is registered as an active team member.
  // This satisfies teamCount >= 1 in the status route (profileComplete check).
  // Use a placeholder password_hash since this user already has a valid JWT.
  const memberId = `tm_${randomUUID().slice(0, 12)}`;
  await safeQuery(
    `INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, '', true)
     ON CONFLICT (email) DO UPDATE SET is_active = true`,
    [memberId, user.email, user.name, user.role],
  );

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "workspace.renamed",
    resourceType: "workspace",
    resourceId: "default",
    beforeState: { name: priorName },
    afterState: { name },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, name });
}
