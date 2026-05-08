/**
 * mail/send-password-reset.ts — password reset email delivery.
 *
 * Mirrors the Resend pattern used by mail/send-invite.ts. Graceful
 * fallback when RESEND_API_KEY is unset (caller surfaces the link
 * back to the requester for hand-delivery — same UX shipped for the
 * invite flow).
 */
export interface ResetEmailArgs {
  to: string;
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface ResetEmailResult {
  delivered: boolean;
  reason?: "no_api_key" | "test_env" | "provider_error" | "ok";
}

const DEFAULT_FROM = "Wolfpack Instinct <invites@wolfpack.agency>";

function publicBase(): string {
  return (
    process.env.INSTINCT_PUBLIC_URL?.replace(/\/$/, "") ??
    "https://wolfpack-instinct.vercel.app"
  );
}

export function buildResetUrl(token: string): string {
  return `${publicBase()}/reset-password?token=${encodeURIComponent(token)}`;
}

export function buildResetEmailBody(args: ResetEmailArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Reset your Wolfpack Instinct password";
  const text =
    `Hi ${args.name},\n\n` +
    `A password reset was requested for your Wolfpack Instinct account.\n\n` +
    `Set a new password (link expires in ${args.expiresInMinutes} minutes):\n${args.resetUrl}\n\n` +
    `If you didn't request this, you can ignore this email — your current password still works.`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#212124;color:#fff;padding:32px;max-width:560px;margin:0 auto;border-radius:12px">
  <h1 style="color:#f1c233;margin:0 0 16px 0;font-size:22px">Reset your password</h1>
  <p style="color:#a0a8b4;margin:0 0 12px 0;line-height:1.55">
    Hi ${escapeHtml(args.name)}, a password reset was requested for your Wolfpack Instinct account.
  </p>
  <p style="margin:24px 0">
    <a href="${args.resetUrl}" style="display:inline-block;background:#f1c233;color:#212124;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Set a new password</a>
  </p>
  <p style="color:#5e6e80;font-size:13px;margin:24px 0 0 0">
    Or paste this link into your browser:<br/>
    <span style="color:#a0a8b4;word-break:break-all">${escapeHtml(args.resetUrl)}</span>
  </p>
  <p style="color:#5e6e80;font-size:12px;margin-top:24px">
    The link expires in ${args.expiresInMinutes} minutes.
  </p>
  <p style="color:#5e6e80;font-size:12px;margin-top:24px;border-top:1px solid #3a3a40;padding-top:16px">
    If you didn't request this, you can ignore this email. Your current password still works.
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

export async function defaultSendResetEmail(
  args: ResetEmailArgs,
): Promise<ResetEmailResult> {
  if (process.env.NODE_ENV === "test") {
    return { delivered: false, reason: "test_env" };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[send-password-reset] RESEND_API_KEY not set — reset email skipped for",
      args.to.replace(/@.*/, "@..."),
    );
    return { delivered: false, reason: "no_api_key" };
  }
  const from = process.env.INSTINCT_INVITE_FROM ?? DEFAULT_FROM;
  const { subject, text, html } = buildResetEmailBody(args);
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
        `[send-password-reset] resend ${res.status}: ${body.slice(0, 200)}`,
      );
      return { delivered: false, reason: "provider_error" };
    }
    return { delivered: true, reason: "ok" };
  } catch (err) {
    console.warn(
      "[send-password-reset] network error:",
      (err as Error).message,
    );
    return { delivered: false, reason: "provider_error" };
  }
}

export async function sendResetEmail(
  args: ResetEmailArgs,
  send: (a: ResetEmailArgs) => Promise<ResetEmailResult> = defaultSendResetEmail,
): Promise<ResetEmailResult> {
  return send(args);
}
