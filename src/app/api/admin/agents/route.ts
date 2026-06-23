/**
 * Agent principals collection API (OGIAM, agents as first-class users).
 *
 *   POST /api/admin/agents: invite/create an agent principal. Minting an AI
 *     principal is a capability grant, so it is gated on settings.manage_team
 *     (the same gate that invites human teammates) and hash-chained in the audit
 *     log. The one-time onboarding secret is returned ONCE; only its hash is ever
 *     stored. A lower admin cannot mint a top-privilege (ceo/cto) agent.
 *
 *   GET /api/admin/agents: list the workspace's agent principals. The secret
 *     hash never leaves the store, so the list is safe to render.
 *
 * Workspace-scoped throughout: an admin only ever sees / creates agents in their
 * own workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { isTeamRole } from "@/lib/auth/role-capabilities";
import { createAgent, listAgents } from "@/lib/agents/store";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Top-privilege agent roles. Only a ceo/cto caller may mint an agent at these
 * roles; a lower admin with settings.manage_team must not be able to escalate by
 * proxy and create a principal stronger than themselves.
 */
const TOP_PRIVILEGE_ROLES = new Set(["ceo", "cto"]);

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: {
    name?: unknown;
    role?: unknown;
    owner_user_id?: unknown;
    description?: unknown;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "invalid_input", detail: "name is required" },
      { status: 400 },
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: "invalid_input", detail: `name exceeds ${MAX_NAME_LENGTH} characters` },
      { status: 400 },
    );
  }

  const role = typeof body.role === "string" ? body.role : "";
  if (!isTeamRole(role)) {
    return NextResponse.json(
      { error: "invalid_input", detail: "role is not a valid team role" },
      { status: 400 },
    );
  }

  /* Privilege ceiling: only a ceo/cto may mint a ceo/cto agent. A lower admin
     holding settings.manage_team must not escalate by proxy. */
  if (TOP_PRIVILEGE_ROLES.has(role) && !TOP_PRIVILEGE_ROLES.has(user.role)) {
    return NextResponse.json(
      { error: "forbidden", detail: "only ceo/cto may create a top-privilege agent" },
      { status: 403 },
    );
  }

  let description: string | undefined;
  if (typeof body.description === "string" && body.description.trim()) {
    description = body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  }

  const ownerUserId =
    typeof body.owner_user_id === "string" && body.owner_user_id.trim()
      ? body.owner_user_id.trim()
      : user.id;

  const workspaceId = user.workspaceId ?? "default";

  let created: Awaited<ReturnType<typeof createAgent>>;
  try {
    created = await createAgent({
      workspaceId,
      name,
      role,
      ownerUserId,
      createdBy: user.id,
      createdByRole: user.role,
      description,
    });
  } catch (err) {
    /* A duplicate name within the workspace surfaces as a unique-constraint
       violation from writeQuery. Map it to a clean 409 rather than a 500. */
    const msg = (err as Error).message ?? "";
    if (/duplicate|unique|already exists|name_taken/i.test(msg)) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    console.error("[admin/agents POST] create failed:", msg);
    return NextResponse.json(
      { error: "internal", code: "create_failed" },
      { status: 500 },
    );
  }

  const { agent, onboardingSecret } = created;

  /* Minting an AI principal is a capability grant: hash-chain it. The secret is
     never recorded; only the identity attributes of the new principal. */
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "agent.created",
      resourceType: "agent",
      resourceId: agent.id,
      afterState: {
        role: agent.role,
        owner_user_id: agent.ownerUserId,
        identity_provider: agent.identityProvider,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[admin/agents POST audit]", (err as Error).message);
  }

  /* onboarding_secret is shown ONCE. The caller must capture it now; the store
     keeps only its hash. */
  return NextResponse.json(
    { agent, onboarding_secret: onboardingSecret },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";
  const agents = await listAgents(workspaceId);
  return NextResponse.json({ agents });
}
