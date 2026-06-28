/**
 * /api/admin/gate/api-keys - mint + list EXTERNAL gate API keys.
 *
 *   POST → mint a scoped key for an external agent. Body:
 *            { agent: string, capabilities: string[] }
 *          Returns the PLAINTEXT key ONCE (never re-shown), plus the masked
 *          metadata. The workspaceId + createdBy come from the caller's session,
 *          NEVER the body, so a privileged user can't mint into another tenant.
 *   GET  → list the caller's workspace keys, MASKED (prefix + last4 only, never
 *          the hash or plaintext).
 *
 * Revoke is the DELETE on the [id] subroute.
 *
 * Capability: settings.manage_team (same gate as the OGIAM decision explorer -
 * the people who manage the team are the people who authorize external agents
 * to act on the workspace's behalf). Every mint is audit-logged.
 *
 * Mirrors the connectors/github-app route idiom: requireCapability → validate →
 * lib call → recordAudit.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { createApiKey, listApiKeys } from "@/lib/ogiam/api-keys";

interface PostBody {
  agent?: unknown;
  capabilities?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const workspaceId = user.workspaceId;

  let body: PostBody | null;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  if (!agent) {
    return NextResponse.json(
      { error: "agent is required (a label for the external agent)" },
      { status: 400 },
    );
  }
  if (agent.length > 200) {
    return NextResponse.json(
      { error: "agent label too long (max 200 chars)" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.capabilities)) {
    return NextResponse.json(
      { error: "capabilities must be an array of strings" },
      { status: 400 },
    );
  }
  if (body.capabilities.some((c) => typeof c !== "string")) {
    return NextResponse.json(
      { error: "capabilities must be an array of strings" },
      { status: 400 },
    );
  }
  const capabilities = body.capabilities as string[];

  const minted = await createApiKey({
    workspaceId,
    agent,
    capabilities,
    createdBy: user.id,
  });

  /* Audit the mint. The PLAINTEXT KEY is NEVER written to the audit log - only
     the non-secret prefix + last4 + scope. */
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "gate.api_key.minted",
    resourceType: "gate_api_key",
    resourceId: minted.id,
    afterState: {
      workspace_id: workspaceId,
      agent,
      prefix: minted.prefix,
      last4: minted.last4,
      capabilities,
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  /* The plaintext key is returned ONCE. The client must store it now; it can
     never be retrieved again. */
  return NextResponse.json(
    {
      id: minted.id,
      key: minted.plaintextKey,
      prefix: minted.prefix,
      last4: minted.last4,
      agent,
      capabilities,
      message:
        "Store this key now. It is shown once and cannot be retrieved again.",
    },
    { status: 200 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId;

  const keys = await listApiKeys(workspaceId);
  return NextResponse.json({ workspace_id: workspaceId, keys });
}
