/**
 * The ONE guarded sender for every tenant-facing Forcefield email.
 *
 * Every message to a tenant's address (the onboarding confirmation, the
 * "Forcefield is watching <site>" first-evidence email, the tenant's immediate
 * alerts and its daily digest) is sent here and nowhere else. Before anything
 * leaves, the recipient is checked against the recipient allowlist
 * (recipient-allowlist.ts, FORCEFIELD_RECIPIENT_DOMAINS). A refused address is
 * never handed to the mail provider: the call returns
 * { delivered: false, reason: "recipient_not_allowlisted" } and records
 * forcefield.tenant_mail_blocked so the demand is visible, not lost.
 *
 * Mail goes through Microsoft Graph (sendViaGraph), never Resend. Never throws.
 *
 * Local development only: FORCEFIELD_MAIL_OUTBOX_DIR writes each allowlisted
 * message to that folder (one .json per message) INSTEAD of sending it, so a
 * local end-to-end run can read the sign-in link and the first-hour email
 * without any mail leaving the machine. Ignored whenever NODE_ENV is
 * "production". The allowlist check still runs first.
 * The guardrail test (forcefield-alert-delivery-guardrail.test.ts) pins that this
 * file and forcefield-web/alerts.ts are the only Forcefield files that import a
 * sender, and that this file checks the allowlist before its single send.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendViaGraph } from "@/lib/mail/send-via-graph";
import { trackEvent } from "@/lib/analytics";
import { isRecipientAllowed, emailDomain } from "@/lib/forcefield-web/recipient-allowlist";

/** What a tenant email is for (analytics + the outcome record). */
export type TenantMailPurpose = "confirm" | "first_evidence" | "alert" | "digest" | "exposure";

export interface TenantMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  purpose: TenantMailPurpose;
  tenantId: string;
}

export interface TenantMailResult {
  delivered: boolean;
  /** "ok", a Graph reason (no_mail_from, scope_missing, ...), or
   *  "recipient_not_allowlisted" when the allowlist refused the address. */
  reason: string;
}

/** The local-development outbox folder, or null (always null in production). */
export function mailOutboxDir(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const dir = String(process.env.FORCEFIELD_MAIL_OUTBOX_DIR ?? "").trim();
  return dir || null;
}

function writeOutbox(dir: string, mail: TenantMail): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${mail.purpose}-${mail.tenantId.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ ...mail, outbox: true }, null, 2));
  return file;
}

/** Injectable sender so tests never reach Graph. */
export type GraphSender = typeof sendViaGraph;

export async function sendForcefieldTenantMail(mail: TenantMail, send: GraphSender = sendViaGraph): Promise<TenantMailResult> {
  if (!isRecipientAllowed(mail.to)) {
    trackEvent("forcefield.tenant_mail_blocked", "system", "forcefield", {
      purpose: mail.purpose,
      tenant_id: mail.tenantId,
      recipient_domain: emailDomain(mail.to) ?? "invalid",
    });
    return { delivered: false, reason: "recipient_not_allowlisted" };
  }
  const outbox = mailOutboxDir();
  if (outbox) {
    try {
      writeOutbox(outbox, mail);
      trackEvent("forcefield.tenant_mail_sent", "system", "forcefield", { purpose: mail.purpose, tenant_id: mail.tenantId, delivered: false, reason: "dev_outbox" });
      return { delivered: true, reason: "dev_outbox" };
    } catch {
      return { delivered: false, reason: "dev_outbox_failed" };
    }
  }
  try {
    const res = await send({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, fromName: "OGIAM Forcefield" });
    trackEvent("forcefield.tenant_mail_sent", "system", "forcefield", {
      purpose: mail.purpose,
      tenant_id: mail.tenantId,
      delivered: res.delivered,
      reason: res.reason,
    });
    return { delivered: res.delivered, reason: res.reason };
  } catch (err) {
    return { delivered: false, reason: `send_threw:${((err as Error)?.message ?? "unknown").slice(0, 80)}` };
  }
}
