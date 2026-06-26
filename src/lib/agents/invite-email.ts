/**
 * agents/invite-email.ts — email an invitee a join link + the one-time agent
 * onboarding secret, so an operator can be "invited by email to join" as the
 * human steward of a newly minted agent principal.
 *
 * This REUSES the existing transactional sender (`sendViaGraph` from
 * `@/lib/mail/send-via-graph`, the same Microsoft Graph path the human team
 * invite uses) — it does NOT add a new mailer. We compose subject/text/html
 * here and hand them to that sender.
 *
 * Best-effort by contract: NEVER throws. The agent row + its onboarding secret
 * already exist by the time this is called; a mail failure must not roll that
 * back or fail agent creation. On any failure we log once and return
 * { ok: false }.
 *
 * The onboarding secret is shown ONCE at creation (only its hash is stored), so
 * the email is the single delivery channel for the operator — the copy makes
 * the one-time nature explicit.
 */
import { sendViaGraph } from "@/lib/mail/send-via-graph";

export interface AgentInviteEmailInput {
  to: string;
  agentName: string;
  agentId: string;
  onboardingSecret: string;
  activationUrl: string;
  invitedByRole: string;
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
 * Compose the invite email body. Pure function, exported for direct unit
 * testing of the copy (mirrors send-invite.ts's `buildInviteEmailBody`).
 */
export function buildAgentInviteEmailBody(input: AgentInviteEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `You're invited to join Wolfpack Instinct as ${input.agentName}`;
  const text =
    `Hi,\n\n` +
    `A ${input.invitedByRole} has invited you to join Wolfpack Instinct as the ` +
    `operator of the agent "${input.agentName}".\n\n` +
    `Activate the agent here:\n${input.activationUrl}\n\n` +
    `One-time onboarding secret (used once to activate, then never shown again):\n` +
    `${input.onboardingSecret}\n\n` +
    `Keep this secret private. It activates the agent a single time; after that ` +
    `it stops working. If you weren't expecting this, you can ignore the email.`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#212124;color:#fff;padding:32px;max-width:560px;margin:0 auto;border-radius:12px">
  <h1 style="color:#f1c233;margin:0 0 8px 0;font-size:24px;line-height:1.2">You're invited to join Wolfpack Instinct</h1>
  <p style="color:#a0a8b4;margin:0 0 20px 0;font-size:14px">As the operator of an agent.</p>

  <p style="color:#e6e6e6;margin:0 0 20px 0;line-height:1.55;font-size:15px">
    A <strong style="color:#fff">${escapeHtml(input.invitedByRole)}</strong> has invited you to operate the agent
    <strong style="color:#fff">${escapeHtml(input.agentName)}</strong>.
  </p>

  <p style="margin:24px 0">
    <a href="${input.activationUrl}" style="display:inline-block;background:#f1c233;color:#212124;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Activate the agent</a>
  </p>

  <p style="color:#5e6e80;font-size:13px;margin:24px 0 0 0">
    Or paste this link into your browser:<br/>
    <span style="color:#a0a8b4;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px">${escapeHtml(input.activationUrl)}</span>
  </p>

  <p style="color:#e6e6e6;font-size:13px;margin:20px 0 0 0;line-height:1.55">
    One-time onboarding secret (used once to activate, then never shown again):<br/>
    <span style="color:#f1c233;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px">${escapeHtml(input.onboardingSecret)}</span>
  </p>

  <p style="color:#5e6e80;font-size:12px;margin-top:32px;border-top:1px solid #3a3a40;padding-top:16px;line-height:1.55">
    Keep this secret private. It activates the agent a single time; after that it stops working.
    If you weren't expecting this, you can ignore the email.
  </p>
</div>
  `.trim();
  return { subject, text, html };
}

/**
 * Send the agent invite email via the existing Graph sender. Best-effort:
 * catches everything and returns { ok: false } rather than throwing, so the
 * caller (agent creation) never fails on a mail problem.
 */
export async function sendAgentInviteEmail(
  input: AgentInviteEmailInput,
): Promise<{ ok: boolean }> {
  try {
    const { subject, text, html } = buildAgentInviteEmailBody(input);
    const res = await sendViaGraph({ to: input.to, subject, text, html });
    return { ok: res.delivered };
  } catch (err) {
    console.warn(
      "[agents/invite-email] send failed:",
      (err as Error).message,
    );
    return { ok: false };
  }
}
