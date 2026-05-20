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

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as { to?: string } | null;
  const to = body?.to || auth.user.email || "homyk@thewolfpack.agency";

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
    result,
  });
}
