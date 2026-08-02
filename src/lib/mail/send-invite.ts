/**
 * mail/send-invite.ts — team-invite email delivery.
 *
 * Mirrors the Resend pattern used by site-forms.ts:
 *   - Reads RESEND_API_KEY at call time (graceful when missing — logs +
 *     skips, never throws to the caller's response path).
 *   - From address defaults to invites@wolfpack.agency, override via
 *     INSTINCT_INVITE_FROM.
 *   - Public URL base for the accept link defaults to the live Vercel
 *     alias, override via INSTINCT_PUBLIC_URL.
 *   - Returns { delivered: boolean, reason?: string } so the caller can
 *     surface "email skipped — copy this link instead" in the UI.
 *
 * NEVER throws. The invite-row insert has already happened by the time
 * this is called — losing the email must not roll that back.
 */
import { sendViaGraph, isGraphMailConfigured } from "@/lib/mail/send-via-graph";

export interface InviteEmailArgs {
  to: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  acceptUrl: string;
}

export interface InviteEmailResult {
  delivered: boolean;
  reason?:
    | "no_api_key"
    | "test_env"
    | "provider_error"
    | "ok"
    | "no_mail_from"
    | "no_app_token"
    | "scope_missing"
    | "seed_recipient";
  /** Which provider actually delivered (or attempted). Lets the UI
   *  show "sent via M365" vs "sent via Resend" for debugging. */
  provider?: "graph" | "resend";
}

const DEFAULT_FROM = "Wolfpack Instinct <invites@wolfpack.agency>";

function publicBase(): string {
  return (
    process.env.INSTINCT_PUBLIC_URL?.replace(/\/$/, "") ??
    "https://wolfpack-instinct.vercel.app"
  );
}

export function buildAcceptUrl(token: string): string {
  return `${publicBase()}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Display names for the seven canonical roles. Keeps email copy from
 * showing "cto" twice when the inviter's name fell back to a role label.
 */
const ROLE_DISPLAY: Record<string, string> = {
  ceo: "Chief Executive Officer",
  cto: "Chief Technology Officer",
  evp: "Executive Vice President",
  vp: "Vice President",
  cco: "Chief Creative Officer",
  hr: "HR",
  dev: "Developer",
  sales: "Sales",
  ops: "Operations",
};

function roleLabel(role: string): string {
  return ROLE_DISPLAY[role.toLowerCase()] ?? role;
}

export function buildInviteEmailBody(args: InviteEmailArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const role = roleLabel(args.role);
  const subject = `You're invited to Wolfpack Instinct`;
  const text =
    `Hi,\n\n` +
    `${args.inviterName} has invited you to join Wolfpack Instinct, our team intelligence platform. ` +
    `You'll be set up with ${role} access.\n\n` +
    `Set your password and finish creating your account:\n${args.acceptUrl}\n\n` +
    `The link expires after first use. If you weren't expecting this, you can ignore the email.\n\n` +
    `— ${args.inviterName} (${args.inviterEmail})`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#212124;color:#fff;padding:32px;max-width:560px;margin:0 auto;border-radius:12px">
  <h1 style="color:#f1c233;margin:0 0 8px 0;font-size:24px;line-height:1.2">You're invited to Wolfpack Instinct</h1>
  <p style="color:#a0a8b4;margin:0 0 20px 0;font-size:14px">Our team intelligence platform.</p>

  <p style="color:#e6e6e6;margin:0 0 20px 0;line-height:1.55;font-size:15px">
    <strong style="color:#fff">${escapeHtml(args.inviterName)}</strong> has added you with
    <strong style="color:#fff">${escapeHtml(role)}</strong> access.
  </p>

  <p style="margin:24px 0">
    <a href="${escapeHtml(args.acceptUrl)}" style="display:inline-block;background:#f1c233;color:#212124;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Set your password</a>
  </p>

  <p style="color:#5e6e80;font-size:13px;margin:24px 0 0 0">
    Or paste this link into your browser:<br/>
    <span style="color:#a0a8b4;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px">${escapeHtml(args.acceptUrl)}</span>
  </p>

  <p style="color:#5e6e80;font-size:12px;margin-top:32px;border-top:1px solid #3a3a40;padding-top:16px;line-height:1.55">
    The link expires after first use. If you weren't expecting this, you can ignore the email.<br/>
    Invited by ${escapeHtml(args.inviterName)} &lt;${escapeHtml(args.inviterEmail)}&gt;.
  </p>
</div>
  `.trim();
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Default sender. Provider priority:
 *   1. Microsoft Graph (`sendViaGraph`) when MS_MAIL_FROM is set AND
 *      app-only token + Mail.Send permission resolve. Free (M365) and
 *      sends from a real wolfpack mailbox — no DNS dance.
 *   2. Resend when RESEND_API_KEY is set. Existing path, requires
 *      DNS verification on the sending domain.
 *   3. Skip + report no_api_key so the API route can return dev_link
 *      for hand-delivery (the May 8 / May 20 fallback flow).
 *
 * Tests inject their own override.
 */
export async function defaultSendInviteEmail(
  args: InviteEmailArgs,
): Promise<InviteEmailResult> {
  if (process.env.NODE_ENV === "test") {
    return { delivered: false, reason: "test_env" };
  }
  const { subject, text, html } = buildInviteEmailBody(args);

  if (isGraphMailConfigured()) {
    const graph = await sendViaGraph({ to: args.to, subject, text, html });
    if (graph.delivered) {
      return { delivered: true, reason: "ok", provider: "graph" };
    }
    // Graph attempted but failed — log once and fall through to Resend
    // if available, otherwise return the Graph-specific reason so the
    // API surface knows which gap to surface.
    console.warn(
      "[send-invite] graph send failed:",
      graph.reason,
      graph.detail ?? "",
    );
    if (!process.env.RESEND_API_KEY) {
      return { delivered: false, reason: graph.reason, provider: "graph" };
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[send-invite] no mail provider configured (MS_MAIL_FROM and RESEND_API_KEY both unset) — invite email skipped for",
      args.to.replace(/@.*/, "@..."),
    );
    return { delivered: false, reason: "no_api_key" };
  }
  const from = process.env.INSTINCT_INVITE_FROM ?? DEFAULT_FROM;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: args.to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[send-invite] resend ${res.status}: ${body.slice(0, 200)}`,
      );
      return { delivered: false, reason: "provider_error", provider: "resend" };
    }
    return { delivered: true, reason: "ok", provider: "resend" };
  } catch (err) {
    console.warn(
      "[send-invite] network error:",
      (err as Error).message,
    );
    return { delivered: false, reason: "provider_error", provider: "resend" };
  }
}

/**
 * Caller-facing entry. Accepts an optional `send` override so the
 * caller (and tests) can substitute a stub. Default delegates to
 * Resend via `defaultSendInviteEmail`.
 */
export async function sendInviteEmail(
  args: InviteEmailArgs,
  send: (a: InviteEmailArgs) => Promise<InviteEmailResult> = defaultSendInviteEmail,
): Promise<InviteEmailResult> {
  return send(args);
}
