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
export interface InviteEmailArgs {
  to: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  acceptUrl: string;
}

export interface InviteEmailResult {
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

export function buildAcceptUrl(token: string): string {
  return `${publicBase()}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildInviteEmailBody(args: InviteEmailArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `${args.inviterName} invited you to Wolfpack Instinct`;
  const text =
    `${args.inviterName} (${args.inviterEmail}) added you to Wolfpack Instinct as ${args.role}.\n\n` +
    `Accept the invite and set your password:\n${args.acceptUrl}\n\n` +
    `If you didn't expect this email, you can ignore it.`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#212124;color:#fff;padding:32px;max-width:560px;margin:0 auto;border-radius:12px">
  <h1 style="color:#f1c233;margin:0 0 16px 0;font-size:22px">Welcome to Wolfpack Instinct</h1>
  <p style="color:#a0a8b4;margin:0 0 12px 0;line-height:1.55">
    <strong style="color:#fff">${escapeHtml(args.inviterName)}</strong>
    (${escapeHtml(args.inviterEmail)}) added you to Wolfpack Instinct as
    <strong style="color:#fff">${escapeHtml(args.role)}</strong>.
  </p>
  <p style="margin:24px 0">
    <a href="${args.acceptUrl}" style="display:inline-block;background:#f1c233;color:#212124;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Accept invite &amp; set password</a>
  </p>
  <p style="color:#5e6e80;font-size:13px;margin:24px 0 0 0">
    Or paste this link into your browser:<br/>
    <span style="color:#a0a8b4;word-break:break-all">${escapeHtml(args.acceptUrl)}</span>
  </p>
  <p style="color:#5e6e80;font-size:12px;margin-top:32px;border-top:1px solid #3a3a40;padding-top:16px">
    If you didn't expect this email, you can ignore it. The link expires after first use.
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
 * Default Resend-backed sender. Tests inject their own.
 */
export async function defaultSendInviteEmail(
  args: InviteEmailArgs,
): Promise<InviteEmailResult> {
  if (process.env.NODE_ENV === "test") {
    return { delivered: false, reason: "test_env" };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[send-invite] RESEND_API_KEY not set — invite email skipped for",
      args.to.replace(/@.*/, "@..."),
    );
    return { delivered: false, reason: "no_api_key" };
  }
  const from = process.env.INSTINCT_INVITE_FROM ?? DEFAULT_FROM;
  const { subject, text, html } = buildInviteEmailBody(args);
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
      return { delivered: false, reason: "provider_error" };
    }
    return { delivered: true, reason: "ok" };
  } catch (err) {
    console.warn(
      "[send-invite] network error:",
      (err as Error).message,
    );
    return { delivered: false, reason: "provider_error" };
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
