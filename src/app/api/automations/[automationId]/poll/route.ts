/**
 * POST /api/automations/[automationId]/poll — kick the inbox poller.
 *
 * Auth: `automations.run` capability required.
 *
 * Returns a `PollResult` describing how many messages were seen,
 * matched, ingested vs. duplicate vs. quarantined, and how long the
 * tick took.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { pollInbox, getMailboxBases } from "@/lib/automations/inbox-poller";
import type { AutomationId } from "@/lib/automations/types";
import { getObsClient } from "@/lib/obs";
import { getValidToken } from "@/lib/microsoft-graph";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/**
 * Pull the N most-recent open exceptions (parser quarantines) so the
 * Run-now response can show an operator exactly what failed and why
 * without making them dig into /diag. Best-effort — DB errors return [].
 */
async function recentQuarantines(automationId: string): Promise<
  Array<{
    artifact_id: string | null;
    kind: string;
    detail: string;
    source_message_id: string | null;
    received_at: string | null;
    mime: string | null;
    subject_hint: string | null;
    created_at: string;
  }>
> {
  if (automationId !== "porsche-classes") return [];
  try {
    const r = await query<{
      artifact_id: string | null;
      kind: string;
      detail: string;
      source_message_id: string | null;
      received_at: string | null;
      mime: string | null;
      subject_hint: string | null;
      created_at: string;
    }>(
      `SELECT
         e.artifact_id::text                         AS artifact_id,
         e.kind                                      AS kind,
         e.detail                                    AS detail,
         a.source_message_id                         AS source_message_id,
         a.received_at::text                         AS received_at,
         a.mime                                      AS mime,
         /* The first 80 bytes of bytes is usually a Subject: header
            for .eml ingests; gives the operator a quick "this was
            the BA101 5/4 instructor email" cue without exposing the
            whole body. xlsx ingests get null here. */
         CASE WHEN a.mime = 'message/rfc822'
           THEN convert_from(substring(a.bytes from 1 for 200), 'UTF8')
           ELSE NULL
         END                                         AS subject_hint,
         e.created_at::text                          AS created_at
       FROM instinct_automation_porsche_exceptions e
       LEFT JOIN instinct_automation_porsche_artifacts a
         ON a.id = e.artifact_id
       WHERE e.created_at > NOW() - interval '1 hour'
       ORDER BY e.created_at DESC
       LIMIT 10`,
      [],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/**
 * Probe Graph for "what mailbox does our token actually read, and what
 * does its inbox look like right now". Called only when messages_seen
 * is 0 so the operator gets actionable diag inline without a separate
 * URL hit. Best-effort — every branch returns a partial shape, never
 * throws.
 */
async function probeForDiag(userId: string): Promise<{
  token_email: string | null;
  me_userPrincipalName: string | null;
  inbox_total: number | null;
  inbox_unread: number | null;
  inbox_newest: Array<{ subject: string; from: string; receivedDateTime: string }>;
  fallback_count: number | null;
  error: string | null;
  /** The actual mailbox base the search-mode poller uses. When this
      differs from `/me`, the poller is reading a shared/delegated
      mailbox via AUTOMATION_POLL_MAILBOX_UPN, NOT the operator's own
      inbox. The cognito email may be in /me but absent from there. */
  poller_mailbox_base: string;
  /** What ENV the search/poll path resolves the UPN to, useful for
      seeing which mailbox is actually being polled. */
  automation_poll_mailbox_upn: string | null;
  /** What `/users/{upn}/mailFolders/inbox` reports — totals + 5
      newest. Empty / 404 means the poller is pointed at a mailbox
      it can't read. */
  upn_inbox_total: number | null;
  upn_inbox_newest: Array<{ subject: string; from: string; receivedDateTime: string }>;
  upn_status: number | null;
  /** Multi-mailbox: every base the poller actually iterates this
      tick (resolved from AUTOMATION_POLL_MAILBOX_UPNS / UPN / /me).
      Each entry includes the mailbox's inbox total + 5 newest so
      the operator can verify whether the target email lives in any
      of them. */
  bases: Array<{
    base: string;
    inbox_total: number | null;
    status: number | null;
    newest: Array<{ subject: string; from: string; receivedDateTime: string }>;
  }>;
}> {
  const upnEnv = (process.env.AUTOMATION_POLL_MAILBOX_UPN || "").trim();
  const pollerBase = upnEnv ? `/users/${encodeURIComponent(upnEnv)}` : "/me";
  const allBases = getMailboxBases();
  const out = {
    token_email: null as string | null,
    me_userPrincipalName: null as string | null,
    inbox_total: null as number | null,
    inbox_unread: null as number | null,
    inbox_newest: [] as Array<{ subject: string; from: string; receivedDateTime: string }>,
    fallback_count: null as number | null,
    error: null as string | null,
    poller_mailbox_base: pollerBase,
    automation_poll_mailbox_upn: upnEnv || null,
    upn_inbox_total: null as number | null,
    upn_inbox_newest: [] as Array<{
      subject: string;
      from: string;
      receivedDateTime: string;
    }>,
    upn_status: null as number | null,
    bases: [] as Array<{
      base: string;
      inbox_total: number | null;
      status: number | null;
      newest: Array<{ subject: string; from: string; receivedDateTime: string }>;
    }>,
  };
  try {
    const tok = await getValidToken(userId);
    if (!tok) {
      out.error = "no_valid_token";
      return out;
    }
    out.token_email = tok.userEmail ?? null;
    const auth = { Authorization: `Bearer ${tok.accessToken}` };
    const meRes = await fetch("https://graph.microsoft.com/v1.0/me", { headers: auth });
    if (meRes.ok) {
      const me = (await meRes.json()) as { userPrincipalName?: string };
      out.me_userPrincipalName = me.userPrincipalName ?? null;
    }
    const folderRes = await fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount",
      { headers: auth },
    );
    if (folderRes.ok) {
      const f = (await folderRes.json()) as { totalItemCount?: number; unreadItemCount?: number };
      out.inbox_total = f.totalItemCount ?? null;
      out.inbox_unread = f.unreadItemCount ?? null;
    }
    const newestRes = await fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=5&$select=subject,from,receivedDateTime&$orderby=receivedDateTime desc",
      { headers: auth },
    );
    if (newestRes.ok) {
      const n = (await newestRes.json()) as {
        value?: Array<{
          subject?: string;
          from?: { emailAddress?: { address?: string } };
          receivedDateTime?: string;
        }>;
      };
      out.inbox_newest = (n.value ?? []).map((m) => ({
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? "",
        receivedDateTime: m.receivedDateTime ?? "",
      }));
    }
    /* Probe the SAME fallback URL the poller builds so we surface
       whether the receivedDateTime ge filter format is being silently
       rejected by Graph. */
    const sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const fallbackUrl =
      `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages` +
      `?$top=50&$orderby=receivedDateTime desc` +
      `&$select=id,subject,receivedDateTime` +
      `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;
    const fbRes = await fetch(fallbackUrl, { headers: auth });
    if (fbRes.ok) {
      const fb = (await fbRes.json()) as { value?: unknown[] };
      out.fallback_count = Array.isArray(fb.value) ? fb.value.length : null;
    } else {
      out.error = `fallback_${fbRes.status}`;
    }
    /* Probe EVERY base the poller actually iterates so the operator
       can confirm whether the target email lives in each mailbox.
       Sequential, best-effort — failures per base are recorded as
       status only, never throw out of the diag. */
    for (const b of allBases) {
      try {
        const baseEntry = {
          base: b,
          inbox_total: null as number | null,
          status: null as number | null,
          newest: [] as Array<{ subject: string; from: string; receivedDateTime: string }>,
        };
        const folderRes = await fetch(
          `https://graph.microsoft.com/v1.0${b}/mailFolders/inbox?$select=totalItemCount`,
          { headers: auth },
        );
        baseEntry.status = folderRes.status;
        if (folderRes.ok) {
          const f = (await folderRes.json()) as { totalItemCount?: number };
          baseEntry.inbox_total = f.totalItemCount ?? null;
          const newestRes = await fetch(
            `https://graph.microsoft.com/v1.0${b}/mailFolders/inbox/messages?$top=10&$select=subject,from,receivedDateTime&$orderby=receivedDateTime desc`,
            { headers: auth },
          );
          if (newestRes.ok) {
            const n = (await newestRes.json()) as {
              value?: Array<{
                subject?: string;
                from?: { emailAddress?: { address?: string } };
                receivedDateTime?: string;
              }>;
            };
            baseEntry.newest = (n.value ?? []).map((m) => ({
              subject: m.subject ?? "",
              from: m.from?.emailAddress?.address ?? "",
              receivedDateTime: m.receivedDateTime ?? "",
            }));
          }
        }
        out.bases.push(baseEntry);
      } catch (err) {
        out.bases.push({
          base: b,
          inbox_total: null,
          status: null,
          newest: [],
        });
        console.warn(
          `[poll/diag] base probe ${b} threw: ${(err as Error).message}`,
        );
      }
    }
    /* Legacy single-UPN diag block (preserved for the existing UI
       widget). Reads the OLD AUTOMATION_POLL_MAILBOX_UPN; the per-
       base loop above is the canonical source of truth. */
    if (pollerBase !== "/me") {
      const upnFolderRes = await fetch(
        `https://graph.microsoft.com/v1.0${pollerBase}/mailFolders/inbox?$select=totalItemCount`,
        { headers: auth },
      );
      out.upn_status = upnFolderRes.status;
      if (upnFolderRes.ok) {
        const f = (await upnFolderRes.json()) as { totalItemCount?: number };
        out.upn_inbox_total = f.totalItemCount ?? null;
        const upnNewestRes = await fetch(
          `https://graph.microsoft.com/v1.0${pollerBase}/mailFolders/inbox/messages?$top=5&$select=subject,from,receivedDateTime&$orderby=receivedDateTime desc`,
          { headers: auth },
        );
        if (upnNewestRes.ok) {
          const n = (await upnNewestRes.json()) as {
            value?: Array<{
              subject?: string;
              from?: { emailAddress?: { address?: string } };
              receivedDateTime?: string;
            }>;
          };
          out.upn_inbox_newest = (n.value ?? []).map((m) => ({
            subject: m.subject ?? "",
            from: m.from?.emailAddress?.address ?? "",
            receivedDateTime: m.receivedDateTime ?? "",
          }));
        }
      }
    }
  } catch (err) {
    out.error = (err as Error).message ?? "probe_threw";
  }
  return out;
}

/**
 * Cron secret check. Vercel Cron Jobs hit the route as GET with
 * `Authorization: Bearer $CRON_SECRET`. We accept that as a stand-in
 * for capability auth so the unattended cron can run without a user
 * session. When the env var is unset (local dev) GET cron auth is
 * disabled and only the POST + capability path works.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runPoll(automationId: string, userId: string, userRole: string) {
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }
  const obs = getObsClient();
  const handle = obs.startSpan(`cron.automations.${automationId}.poll`, {
    automation_id: automationId,
    user_id: userId,
    user_role: userRole,
  });
  try {
    /* Emit a "started" bookend so the learning loop can pair every
       tick with a corresponding "completed" / "skipped" / error event.
       Best-effort — analytics never throws out of the poll path. */
    try {
      trackEvent("automations.poll_started", userId, userRole, {
        automation_id: automationId,
        mailbox_count: getMailboxBases().length,
      });
    } catch {
      /* analytics best-effort */
    }
    const result = await pollInbox({
      automationId: automation.id as AutomationId,
      userId,
      userRole,
    });
    try {
      trackEvent("automations.poll_completed", userId, userRole, {
        automation_id: automationId,
        messages_seen: result.messages_seen,
        messages_matched: result.messages_matched,
        artifacts_ingested: result.artifacts_ingested,
        artifacts_duplicate: result.artifacts_duplicate,
        artifacts_quarantined: result.artifacts_quarantined,
        errors: result.errors,
        duration_ms: result.duration_ms,
      });
    } catch {
      /* analytics best-effort */
    }
    const r = result as unknown as Record<string, unknown> | null | undefined;
    if (r && typeof r === "object") {
      const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
      handle.setAttribute("messages_seen", num("messages_seen") ?? null);
      handle.setAttribute("messages_matched", num("messages_matched") ?? null);
      handle.setAttribute("artifacts_ingested", num("artifacts_ingested") ?? null);
      handle.setAttribute("artifacts_duplicate", num("artifacts_duplicate") ?? null);
      handle.setAttribute("artifacts_quarantined", num("artifacts_quarantined") ?? null);
      handle.setAttribute("errors", num("errors") ?? null);
      handle.setAttribute("duration_ms", num("duration_ms") ?? null);
    }
    handle.end("ok");
    /* When the poll saw nothing, attach a diag block so the operator
       can see immediately whether the token is bound to the expected
       mailbox, what's actually in inbox, and whether the fallback
       filter URL itself returned 0. Surfaces the same data as
       /api/automations/porsche-classes/graph-probe but inline (no
       separate URL hit needed — the dashboard fetch already carries
       the right Authorization header). */
    let diag: Awaited<ReturnType<typeof probeForDiag>> | undefined;
    const seen = (result as unknown as { messages_seen?: number }).messages_seen;
    if (typeof seen === "number" && seen === 0) {
      diag = await probeForDiag(userId);
    }
    /* When this poll quarantined anything, fetch the recent
       exceptions inline so the operator can see what failed and why
       without leaving the Run-now panel. */
    const quarantined = (result as unknown as { artifacts_quarantined?: number })
      .artifacts_quarantined;
    let recent_exceptions: Awaited<ReturnType<typeof recentQuarantines>> | undefined;
    if (typeof quarantined === "number" && quarantined > 0) {
      recent_exceptions = await recentQuarantines(automationId);
    }
    return NextResponse.json({ ok: true, result, diag, recent_exceptions });
  } catch (err) {
    /* "No valid Microsoft token" thrown by ms-graph clients downstream
       of pollInbox is the documented bootstrap state — the cron runs
       before any user has connected their mailbox. Translate to a 200
       with a structured skipped result so the health-monitor workflow
       treats it as a notice (not a failure). */
    const message = (err as Error).message ?? "";
    if (message.includes("No valid Microsoft token")) {
      handle.setAttribute("skipped", "no_user_connected");
      handle.end("ok");
      return NextResponse.json(
        {
          ok: true,
          result: {
            automation_id: automationId,
            messages_seen: 0,
            messages_matched: 0,
            artifacts_ingested: 0,
            artifacts_duplicate: 0,
            artifacts_quarantined: 0,
            errors: 0,
            duration_ms: 0,
            skipped: "no_user_connected",
            skipped_user_id: userId,
          },
        },
        { status: 200 },
      );
    }
    console.error("[automations/poll]", message);
    handle.setAttribute("error_message", message.slice(0, 300));
    handle.end("error");
    obs.recordError(err as Error, {
      route: `cron.automations.${automationId}.poll`,
      automation_id: automationId,
      user_id: userId,
    });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

/**
 * Operator-triggered poll (the "Run now" button on the dashboard).
 * Requires `automations.run` capability + a logged-in user — the
 * mailbox-owning email is taken from the user identity.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const { automationId } = await ctx.params;
  // Service-account path: GitHub Actions cron POSTs with the bearer
  // CRON_SECRET. Accept that as a stand-in for capability auth.
  if (isAuthorizedCron(req)) {
    const userId =
      process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
    const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
    return runPoll(automationId, userId, userRole);
  }
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;
  /* Pass the Instinct user.id — that's what ms_tokens.connected_by
     stores for the demo accounts (e.g. "demo-cto"). getValidToken's
     (connected_by OR user_email) lookup will match user_email for
     non-demo sessions. We deliberately do NOT prefer user.email
     because demo users have a placeholder email (cto@wolfpack.dev)
     that does not match any real Microsoft mailbox; the id is the
     stable anchor. */
  return runPoll(automationId, auth.user.id, auth.user.role);
}

/**
 * Cron-triggered poll (Vercel Cron Jobs hit GET with the bearer
 * CRON_SECRET). The userId is taken from `AUTOMATION_POLL_USER_ID` —
 * a service-account identity owned by ops. We do NOT default to the
 * automation's `owner_label` because that's a display label, not a
 * stable id.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  if (!isAuthorizedCron(req)) {
    // Fall back to the user-session path so a logged-in operator can
    // also invoke via GET from the browser if they prefer.
    const auth = await requireCapability(req, "automations.run");
    if (!auth.ok) return auth.response;
    const { automationId } = await ctx.params;
    return runPoll(automationId, auth.user.id, auth.user.role);
  }
  const userId =
    process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
  const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
  const { automationId } = await ctx.params;
  return runPoll(automationId, userId, userRole);
}
