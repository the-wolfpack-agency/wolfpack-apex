/**
 * POST /api/admin/mail-diagnose — CTO-only Graph sendMail diagnostic.
 *
 * Calls sendViaGraph with a no-op test message to the requester's email
 * and returns the full result including `detail` (the trimmed Graph
 * response body on non-2xx). This lets us see exactly what Microsoft
 * is rejecting — Application Access Policy, missing permission,
 * mailbox-not-found, etc.
 *
 * Built 2026-05-20 because the forgot-password surface swallows the
 * detail field for security (anti-enumeration) and Vercel function
 * logs weren't surfacing the error inline.
 *
 * Body: { to: string } — defaults to the caller's email if omitted.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { sendViaGraph } from "@/lib/mail/send-via-graph";
import { getAppOnlyToken, _resetAppTokenCacheForTests } from "@/lib/microsoft-graph";

/**
 * Decode the middle segment of a JWT to inspect claims. App-only Graph
 * tokens carry `roles: ["Mail.Send", "Mail.Read", ...]` — the
 * application permissions actually present. If Mail.Send is missing
 * here, admin consent didn't propagate. If present but sendMail still
 * 403s, the culprit is an Application Access Policy in Exchange Online.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const middle = token.split(".")[1];
    if (!middle) return null;
    const padded = middle.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(
      padded + "===".slice((padded.length + 3) % 4),
      "base64",
    ).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as { to?: string; reset_token?: boolean } | null;
  const to = body?.to || auth.user.email || "homyk@thewolfpack.agency";

  // Allow forcing a fresh token in case the cached one predates consent
  if (body?.reset_token) {
    _resetAppTokenCacheForTests();
  }

  const token = await getAppOnlyToken();
  const claims = token ? decodeJwtClaims(token) : null;
  const tokenInspect = {
    acquired: Boolean(token),
    roles: (claims?.roles as string[] | undefined) ?? null,
    aud: claims?.aud ?? null,
    iss: claims?.iss ?? null,
    app_id: claims?.appid ?? claims?.azp ?? null,
    tenant_id: claims?.tid ?? null,
    issued_at: claims?.iat ?? null,
    expires_at: claims?.exp ?? null,
    has_mail_send: Array.isArray(claims?.roles)
      ? (claims!.roles as string[]).includes("Mail.Send")
      : false,
  };

  const result = await sendViaGraph({
    to,
    subject: "Instinct mail diagnostic — please disregard",
    text: "If you got this, MS Graph sendMail is working end-to-end.",
    html: "<p>If you got this, MS Graph <code>sendMail</code> is working end-to-end.</p>",
  });

  return NextResponse.json({
    ms_mail_from: process.env.MS_MAIL_FROM ?? null,
    ms_mail_from_name: process.env.MS_MAIL_FROM_NAME ?? null,
    ms_tenant_id_set: Boolean(process.env.MS_TENANT_ID),
    ms_client_id_set: Boolean(process.env.MS_CLIENT_ID),
    ms_client_secret_set: Boolean(process.env.MS_CLIENT_SECRET),
    sent_to: to,
    token: tokenInspect,
    result,
  });
}
