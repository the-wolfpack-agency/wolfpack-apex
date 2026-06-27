import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import {
  issueVerificationToken,
  checkVerification,
  type VerificationMethod,
} from "@/lib/platform-scan/authorization";

/**
 * Target OWNERSHIP VERIFICATION endpoint.
 *
 * POST { platform, action: "issue" }
 *   -> issue (or rotate) a challenge token; returns the token + placement
 *      instructions for both methods. Fires platform.target_verification_requested.
 *
 * POST { platform, action: "check", method: "http_well_known" | "dns_txt" }
 *   -> perform the proof check; on success marks the target verified.
 *
 * Gated on settings.manage_team (same gate as onboarding). Every action is
 * audited via the hash-chained audit log.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = await req.json().catch(() => ({}));
  const platform =
    typeof (body as { platform?: unknown }).platform === "string"
      ? (body as { platform: string }).platform.trim()
      : "";
  const action = (body as { action?: unknown }).action;
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });
  if (action !== "issue" && action !== "check") {
    return NextResponse.json({ error: "action_invalid" }, { status: 400 });
  }

  const meta = extractRequestMetadata(req);

  if (action === "issue") {
    const result = await issueVerificationToken(workspaceId, platform);
    trackEvent("platform.target_verification_requested", user.id, user.role, {
      platform,
      method: "both",
    });
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "platform.target_verification_requested",
      resourceType: "scan_target",
      resourceId: platform,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      // NEVER store the token in the audit afterState.
      afterState: { platform, status: result.status },
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json(
      {
        ok: true,
        platform,
        token: result.token,
        status: result.status,
        verifiedAt: result.verifiedAt,
        instructions: result.instructions,
      },
      { status: 200 },
    );
  }

  // action === "check"
  const method = (body as { method?: unknown }).method;
  if (method !== "http_well_known" && method !== "dns_txt") {
    return NextResponse.json({ error: "method_invalid" }, { status: 400 });
  }

  const result = await checkVerification(workspaceId, platform, method as VerificationMethod, {
    userId: user.id,
    role: user.role,
  });

  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: result.ok ? "platform.target_verified" : "platform.target_verification_failed",
    resourceType: "scan_target",
    resourceId: platform,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: { platform, method, status: result.status, reason: result.reason ?? null },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json(
    {
      ok: result.ok,
      platform,
      method: result.method,
      status: result.status,
      verifiedAt: result.verifiedAt,
      ...(result.reason ? { reason: result.reason } : {}),
    },
    { status: 200 },
  );
}
