/**
 * /api/admin/connectors/github-app - link a GitHub App installation to the
 * caller's workspace, and read the current link + fallback status.
 *
 *   GET  → { configured, installation | null, fallback } where:
 *            configured  = the GitHub App env (id + private key) is present.
 *            installation = the linked installation row (null if none).
 *            fallback    = which token a scan/PR would use right now:
 *                          "installation" | "pat" | "none".
 *   POST → link an installation to the workspace. Body:
 *            { installationId, accountLogin? }  (both strings)
 *          Used by the manual "I installed it, here's my installation id" path
 *          and as the programmatic store behind the post-install callback.
 *   DELETE → unlink the workspace's installation (reverts to PAT fallback).
 *
 * settings.manage_team only. The workspaceId is ALWAYS taken from the caller's
 * session - never from the body/query - so a privileged user can't link an
 * installation into another tenant's row. Every mutation is audit-logged; the
 * link/unlink analytics events fire inside the storage layer.
 *
 * Mirrors the /api/admin/connectors route idiom (requireCapability → validate →
 * storage → recordAudit).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  linkInstallation,
  removeInstallation,
  getInstallation,
  readAppConfigFromEnv,
} from "@/lib/github-app";

interface PostBody {
  installationId?: unknown;
  accountLogin?: unknown;
}

function patConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN_WOLFPACK_AGENCY);
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId;

  const configured = readAppConfigFromEnv() !== null;
  const installation = await getInstallation(workspaceId);

  /* Mirror resolveGithubToken's decision so the UI shows EXACTLY which token a
     scan would use right now without leaking any secret. */
  let fallback: "installation" | "pat" | "none";
  if (configured && installation) fallback = "installation";
  else if (patConfigured()) fallback = "pat";
  else fallback = "none";

  return NextResponse.json({
    configured,
    patConfigured: patConfigured(),
    installation,
    fallback,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: PostBody | null;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const installationId =
    typeof body.installationId === "string"
      ? body.installationId.trim()
      : typeof body.installationId === "number"
        ? String(body.installationId)
        : "";
  // GitHub installation ids are numeric strings; reject anything else so we
  // never store a garbage value that 404s every token exchange.
  if (!/^[0-9]{1,20}$/.test(installationId)) {
    return NextResponse.json(
      { error: "installationId must be a numeric GitHub installation id" },
      { status: 400 },
    );
  }
  let accountLogin: string | null = null;
  if (body.accountLogin !== undefined && body.accountLogin !== null) {
    if (typeof body.accountLogin !== "string") {
      return NextResponse.json(
        { error: "accountLogin must be a string" },
        { status: 400 },
      );
    }
    accountLogin = body.accountLogin.trim() || null;
  }

  /* Workspace resolved server-side, never from the body. */
  const workspaceId = auth.user.workspaceId;

  const installation = await linkInstallation({
    workspaceId,
    installationId,
    accountLogin,
    linkedBy: user.id,
    actorRole: user.role,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "connector.github_app.linked",
    resourceType: "github_app_installation",
    resourceId: `${workspaceId}:${installationId}`,
    afterState: {
      workspace_id: workspaceId,
      installation_id: installationId,
      account_login: accountLogin,
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ installation });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const workspaceId = auth.user.workspaceId;

  const removed = await removeInstallation({
    workspaceId,
    removedBy: user.id,
    actorRole: user.role,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "connector.github_app.removed",
    resourceType: "github_app_installation",
    resourceId: workspaceId,
    afterState: { workspace_id: workspaceId, removed },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ removed });
}
