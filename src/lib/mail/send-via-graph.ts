/**
 * mail/send-via-graph.ts — send transactional email via Microsoft Graph
 * (`/users/{from}/sendMail`) using the app-only client-credentials flow.
 *
 * Why this exists: Wolfpack already pays for M365, the Azure app
 * registration + tenant + client credentials are already wired
 * (MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID) and the app-only
 * token helper (`getAppOnlyToken`) is already shipped. Adding Mail.Send
 * (Application) + admin consent gives us free, branded outbound email
 * with zero DNS work — no Resend signup, no SPF/DKIM dance.
 *
 * Behavior:
 *   - From-mailbox: env `MS_MAIL_FROM` (UPN or object-id of the sending
 *     mailbox, e.g. "noreply@thewolfpack.agency"). When unset, returns
 *     { delivered: false, reason: "no_mail_from" } so the caller falls
 *     back to its next mailer in the chain.
 *   - Token: getAppOnlyToken() returns null when MS env vars are
 *     missing OR admin consent for application permissions hasn't been
 *     granted yet. Returns { delivered: false, reason: "no_app_token" }.
 *   - 403 Forbidden after token acquisition usually means Mail.Send
 *     hasn't been added to the app registration, OR a per-mailbox
 *     Application Access Policy is in effect and excludes MS_MAIL_FROM.
 *     Returns { delivered: false, reason: "scope_missing" }.
 *   - NEVER throws. Reset/invite flows must not 500 because email
 *     misconfig — the write to instinct_password_resets / instinct_invites
 *     has already happened, the dev_link fallback is in the response.
 *
 * The caller's pre-existing return shape is `{ delivered, reason }`
 * where `reason` is a string union. We extend the union with the
 * Graph-specific reasons so analytics / UI can render the right hint.
 */

import { getAppOnlyToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import {
  isSeedEmail,
  seedEmailDomain,
} from "@/lib/mail/undeliverable-recipients";

const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/users";

export type GraphSendReason =
  | "ok"
  | "no_mail_from"
  | "no_app_token"
  | "scope_missing"
  | "provider_error"
  | "seed_recipient";

export interface GraphSendArgs {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Optional display name to compose into the From envelope alongside
   *  the mailbox UPN/object-id. Falls back to MS_MAIL_FROM_NAME or the
   *  mailbox local-part. */
  fromName?: string;
}

export interface GraphSendResult {
  delivered: boolean;
  reason: GraphSendReason;
  /** Surfaced on 4xx/5xx for triage. Trimmed to 200 chars to keep the
   *  Vercel log lines readable. */
  detail?: string;
}

export function isGraphMailConfigured(): boolean {
  return Boolean(process.env.MS_MAIL_FROM && process.env.MS_MAIL_FROM.includes("@"));
}

export async function sendViaGraph(args: GraphSendArgs): Promise<GraphSendResult> {
  /* Final chokepoint (mirrors the recipient-selection guards): never attempt
     delivery to a known-undeliverable seed domain (parked, Null MX — e.g.
     wolfpack.dev). Stops the demo-seed bounce class outright, no matter which
     caller resolved the recipient, and records the suppressed send so the
     learning loop sees demand instead of losing the signal. Runs BEFORE the
     env checks so it is unconditional. */
  if (isSeedEmail(args.to)) {
    trackEvent("mail.seed_recipient_skipped", "system", "system", {
      to: args.to,
      domain: seedEmailDomain(args.to) ?? "unknown",
    });
    return { delivered: false, reason: "seed_recipient" };
  }

  const fromMailbox = process.env.MS_MAIL_FROM;
  if (!fromMailbox || !fromMailbox.includes("@")) {
    return { delivered: false, reason: "no_mail_from" };
  }

  const token = await getAppOnlyToken();
  if (!token) {
    return { delivered: false, reason: "no_app_token" };
  }

  const fromName =
    args.fromName ?? process.env.MS_MAIL_FROM_NAME ?? "Wolfpack Instinct";

  /* Graph sendMail body. saveToSentItems=true keeps a Sent record in
     the mailbox so operators can audit what the system sent — vital
     for "did the reset email actually go" debugging. */
  const body = {
    message: {
      subject: args.subject,
      from: {
        emailAddress: {
          address: fromMailbox,
          name: fromName,
        },
      },
      body: {
        contentType: "HTML",
        content: args.html,
      },
      toRecipients: [
        {
          emailAddress: {
            address: args.to,
          },
        },
      ],
    },
    saveToSentItems: true,
  };

  let res: Response;
  try {
    res = await fetch(
      `${GRAPH_SEND_URL}/${encodeURIComponent(fromMailbox)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return {
      delivered: false,
      reason: "provider_error",
      detail: `network: ${(err as Error).message}`.slice(0, 200),
    };
  }

  if (res.status === 202) {
    return { delivered: true, reason: "ok" };
  }

  const detail = await res.text().catch(() => "");
  if (res.status === 403) {
    /* Mail.Send not granted OR Application Access Policy excludes
       MS_MAIL_FROM. The setup runbook covers both. */
    return {
      delivered: false,
      reason: "scope_missing",
      detail: detail.slice(0, 200),
    };
  }
  return {
    delivered: false,
    reason: "provider_error",
    detail: `${res.status}: ${detail.slice(0, 200)}`,
  };
}
