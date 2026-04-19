/**
 * site-forms.ts — PUBLIC contact-form submission handler logic.
 *
 * The deployed `wolfpack-{slug}.vercel.app` site (or any verified custom
 * domain from `apex_site_domains`) submits a `<form>` POST to
 *   https://wolfpack-instinct.vercel.app/api/public/forms/{siteId}/submit
 * which calls `submitForm()` in this module.
 *
 * Layered safety:
 *   1. Site lookup (`site_not_found`)
 *   2. Brief must have `contactForm` + `recipientEmail` configured
 *      (`no_contact_form` / `no_recipient`)
 *   3. Origin allowlist check against preview_url + verified custom
 *      domains (`origin_not_allowed`)
 *   4. Rate limit: 5 submissions per `ipHash` per 15 minutes
 *      (`rate_limited` with `retryAfterSec`)
 *   5. Honeypot field `_hp_website` — filled → row persisted with
 *      spam_score=100, email_status='throttled', no email sent. Returns
 *      ok=true so bots don't learn. Emits `site.form_rejected`.
 *   6. Field validation — every required field present, no extras,
 *      ≤20 fields total, each value ≤5000 chars.
 *   7. Persist the row + send the email fire-and-forget — the response
 *      does NOT block on SMTP latency.
 *
 * Deps are ALL injectable via `deps` on the input so tests can assert
 * every branch without touching Postgres, Vercel, or Resend.
 *
 * Rate limiter is in-memory. In production, swap `rateLimitCheck` for
 * a Redis-backed implementation (shape: same signature). The current
 * in-memory Map is fine for single-replica Vercel Fn cold starts — it
 * caps abuse at ~5/15min per IP per region, and the row-level audit
 * still catches organized attacks across regions.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { SiteBrief } from "@/lib/sites-schema";

/* ----------------------------- Types ---------------------------------- */

export interface SiteProjectLite {
  id: string;
  client_slug: string;
  display_name: string;
  preview_url: string | null;
  brief: SiteBrief;
}

export interface EmailArgs {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export type FormSubmitReason =
  | "ok"
  | "origin_not_allowed"
  | "rate_limited"
  | "honeypot_tripped"
  | "missing_required_field"
  | "unexpected_field"
  | "too_many_fields"
  | "field_too_long"
  | "site_not_found"
  | "no_contact_form"
  | "no_recipient";

export interface FormSubmitResult {
  ok: boolean;
  reason: FormSubmitReason;
  submissionId?: string;
  retryAfterSec?: number;
  /** Set when reason === 'ok'. Emitted as analytics metadata. */
  fieldCount?: number;
  /** Set when reason === 'ok'. The origin that was accepted. */
  acceptedOrigin?: string;
  /** Set when honeypot tripped so caller can emit spam metrics. */
  spamScore?: number;
}

export interface FormSubmitDeps {
  getSite?: (id: string) => Promise<SiteProjectLite | null>;
  listVerifiedDomains?: (id: string) => Promise<string[]>;
  sendEmail?: (args: EmailArgs) => Promise<void>;
  now?: () => number;
  rateLimitCheck?: (ipHash: string) => Promise<{ allowed: boolean; retryAfterSec?: number }>;
}

export interface FormSubmitInput {
  siteId: string;
  payload: Record<string, string>;
  origin: string;
  ipHash: string;
  userAgent: string | null;
  deps?: FormSubmitDeps;
}

/* ----------------------------- Constants ------------------------------ */

export const HONEYPOT_FIELD = "_hp_website";
export const MAX_FIELDS = 20;
export const MAX_FIELD_LENGTH = 5000;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;

/* ----------------------------- Rate limiter --------------------------- */

interface RateEntry {
  count: number;
  windowStart: number;
}

// Per-process bucket. Swap for a Redis-backed impl in production by
// injecting `deps.rateLimitCheck`. Exposed for tests via `_resetRateLimit`.
const rateBucket = new Map<string, RateEntry>();

export function _resetRateLimit(): void {
  rateBucket.clear();
}

async function defaultRateLimitCheck(
  ipHash: string,
  now: number = Date.now(),
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const entry = rateBucket.get(ipHash);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ipHash, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }
  entry.count += 1;
  return { allowed: true };
}

/* ----------------------------- Helpers -------------------------------- */

/**
 * Normalize an Origin header value to a lowercase host suitable for
 * allowlist matching. Strips scheme, trailing slash, port-insensitive
 * comparison kept intentional because preview_url is always
 * :443-implicit. Returns null when the value can't be parsed.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return u.host.toLowerCase();
  } catch {
    // Not a full URL — caller may pass bare host (e.g. "acme.com").
    const bare = trimmed.toLowerCase().replace(/^https?:\/\//, "");
    return bare || null;
  }
}

/**
 * Default site loader — reads from apex_site_projects. Exposed so the
 * HTTP route can reuse it; tests inject via `deps.getSite`.
 */
export async function defaultGetSite(
  id: string,
): Promise<SiteProjectLite | null> {
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, client_slug, display_name, preview_url, brief
       FROM apex_site_projects
      WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const brief =
    typeof row.brief === "string"
      ? (JSON.parse(row.brief as string) as SiteBrief)
      : (row.brief as SiteBrief);
  return {
    id: String(row.id),
    client_slug: String(row.client_slug),
    display_name: String(row.display_name),
    preview_url: (row.preview_url as string) || null,
    brief,
  };
}

/**
 * Default verified-domain loader — wraps `listDomainsForSite` and
 * filters to status='verified'. Domains are returned lowercased so
 * origin comparison is straightforward.
 */
export async function defaultListVerifiedDomains(siteId: string): Promise<string[]> {
  const { rows } = await safeQuery<{ domain: string; status: string }>(
    `SELECT domain, status FROM apex_site_domains
      WHERE site_id = $1 AND status = 'verified'`,
    [siteId],
  );
  return rows.map((r) => String(r.domain).toLowerCase());
}

/**
 * Build the default email body from the sanitized payload. Returned in
 * both text + HTML form so the email client can pick. HTML is escaped —
 * never raw user input into the DOM.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmail(args: {
  payload: Record<string, string>;
  clientName: string;
  productName: string;
  siteId: string;
  subjectTemplate?: string;
}): { subject: string; bodyText: string; bodyHtml: string } {
  const subjectTpl =
    args.subjectTemplate ?? `[{client}] contact form submission`;
  const subject = subjectTpl
    .replace(/\{client\}/g, args.clientName || args.productName)
    .replace(/\{site\}/g, args.productName || args.clientName)
    .slice(0, 200);

  const lines = Object.entries(args.payload).map(
    ([k, v]) => `${k}: ${v}`,
  );
  const bodyText = [
    `New submission from ${args.productName || args.clientName} site.`,
    "",
    ...lines,
    "",
    `(site_id=${args.siteId})`,
  ].join("\n");

  const rows = Object.entries(args.payload)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 8px;font-weight:bold;">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 8px;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const bodyHtml =
    `<p>New submission from <strong>${escapeHtml(
      args.productName || args.clientName,
    )}</strong> site.</p>` +
    `<table style="border-collapse:collapse;">${rows}</table>` +
    `<p style="color:#888;font-size:11px;">site_id=${escapeHtml(args.siteId)}</p>`;
  return { subject, bodyText, bodyHtml };
}

/**
 * Default email sender. Wires to Resend/Graph/etc. in production; for
 * now it logs the intent so the feature can ship without hard-wiring
 * the transport choice (matches the `digest.ts` seam pattern — we
 * invert the decision so ops can swap transports later without a code
 * change here).
 *
 * The actual production wiring (Resend) should live in
 * `src/lib/notifications/transport.ts` as a shared helper once it
 * exists. For now tests inject a spy.
 */
export async function defaultSendEmail(args: EmailArgs): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[site-forms] RESEND_API_KEY not set — form email skipped (to=",
      args.to.replace(/@.*/, "@...") + ")",
    );
    return;
  }
  const from = process.env.INSTINCT_FORMS_FROM ?? "forms@wolfpack.agency";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        text: args.bodyText,
        html: args.bodyHtml,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`resend_${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    // Callers catch + mark email_status='failed' on the row.
    throw err;
  }
}

/* ----------------------------- Core ----------------------------------- */

function hostFromOrBare(value: string | null | undefined): string | null {
  return normalizeOrigin(value);
}

/**
 * Build the set of allowed origin hosts for a site:
 *   - preview_url host (once deployed)
 *   - every verified custom domain (from apex_site_domains)
 * All lowercased, trailing slash stripped.
 */
export function buildAllowedOrigins(
  site: SiteProjectLite,
  verifiedDomains: string[],
): Set<string> {
  const out = new Set<string>();
  const previewHost = hostFromOrBare(site.preview_url);
  if (previewHost) out.add(previewHost);
  for (const d of verifiedDomains) {
    const h = hostFromOrBare(d);
    if (h) out.add(h);
  }
  return out;
}

/**
 * Orchestrator — implements the full submit flow. See module header for
 * the safety layering. Every non-ok branch is covered by the test suite
 * in `src/lib/__tests__/site-forms.test.ts`.
 */
export async function submitForm(input: FormSubmitInput): Promise<FormSubmitResult> {
  const deps = input.deps ?? {};
  const getSite = deps.getSite ?? defaultGetSite;
  const listVerified = deps.listVerifiedDomains ?? defaultListVerifiedDomains;
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const nowFn = deps.now ?? Date.now;
  const rateCheck =
    deps.rateLimitCheck ?? ((ip: string) => defaultRateLimitCheck(ip, nowFn()));

  // 1. Resolve site.
  const site = await getSite(input.siteId);
  if (!site) {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "site_not_found",
    });
    return { ok: false, reason: "site_not_found" };
  }

  // 2. Brief must declare a contact form.
  const cf = site.brief?.contactForm;
  if (!cf || !Array.isArray(cf.fields)) {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "no_contact_form",
    });
    return { ok: false, reason: "no_contact_form" };
  }

  // 3. Recipient must be configured.
  const recipient = cf.recipientEmail;
  if (!recipient || typeof recipient !== "string") {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "no_recipient",
    });
    return { ok: false, reason: "no_recipient" };
  }

  // 4. Origin allowlist.
  const normalizedOrigin = normalizeOrigin(input.origin);
  const verifiedDomains = await listVerified(input.siteId);
  const allowed = buildAllowedOrigins(site, verifiedDomains);
  if (!normalizedOrigin || !allowed.has(normalizedOrigin)) {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "origin_not_allowed",
      origin: normalizedOrigin ?? "none",
    });
    return { ok: false, reason: "origin_not_allowed" };
  }

  // 5. Rate limit — keyed by IP hash.
  const rate = await rateCheck(input.ipHash);
  if (!rate.allowed) {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "rate_limited",
      retry_after_sec: rate.retryAfterSec ?? 60,
    });
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSec: rate.retryAfterSec ?? 60,
    };
  }

  // 6. Field-shape validation (before honeypot — size caps come first
  //    so a bot can't blow our memory/disk with a 5000-field payload).
  const rawPayload = input.payload ?? {};
  const rawKeys = Object.keys(rawPayload);
  if (rawKeys.length > MAX_FIELDS) {
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "too_many_fields",
      field_count: rawKeys.length,
    });
    return { ok: false, reason: "too_many_fields" };
  }
  for (const k of rawKeys) {
    const v = rawPayload[k];
    if (typeof v === "string" && v.length > MAX_FIELD_LENGTH) {
      trackEvent("site.form_rejected", "public", "public", {
        site_id: input.siteId,
        reason: "field_too_long",
        field: k.slice(0, 32),
      });
      return { ok: false, reason: "field_too_long" };
    }
  }

  // 7. Honeypot — filled = trap. Still persist (spam_score=100,
  //    email_status='throttled') so the learning loop sees attack
  //    patterns; return ok=true to trick the bot.
  const honeypotValue = rawPayload[HONEYPOT_FIELD];
  if (typeof honeypotValue === "string" && honeypotValue.trim().length > 0) {
    const submissionId = await persistSubmission({
      siteId: input.siteId,
      payload: sanitizePayload(rawPayload),
      origin: normalizedOrigin,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      recipientEmail: recipient,
      emailStatus: "throttled",
      emailError: null,
      spamScore: 100,
    });
    trackEvent("site.form_rejected", "public", "public", {
      site_id: input.siteId,
      reason: "honeypot_tripped",
      had_recipient: true,
    });
    return {
      ok: true,
      reason: "honeypot_tripped",
      submissionId: submissionId ?? undefined,
      spamScore: 100,
    };
  }

  // 8. Required-field + unexpected-field checks.
  const declared = new Set(cf.fields);
  for (const required of cf.fields) {
    const v = rawPayload[required];
    if (typeof v !== "string" || v.trim().length === 0) {
      trackEvent("site.form_rejected", "public", "public", {
        site_id: input.siteId,
        reason: "missing_required_field",
        field: required.slice(0, 32),
      });
      return { ok: false, reason: "missing_required_field" };
    }
  }
  for (const k of rawKeys) {
    if (k === HONEYPOT_FIELD) continue;
    if (!declared.has(k)) {
      trackEvent("site.form_rejected", "public", "public", {
        site_id: input.siteId,
        reason: "unexpected_field",
        field: k.slice(0, 32),
      });
      return { ok: false, reason: "unexpected_field" };
    }
  }

  // 9. Persist row with email_status='pending'.
  const sanitized = sanitizePayload(rawPayload);
  delete (sanitized as Record<string, string>)[HONEYPOT_FIELD];
  const submissionId = await persistSubmission({
    siteId: input.siteId,
    payload: sanitized,
    origin: normalizedOrigin,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    recipientEmail: recipient,
    emailStatus: "pending",
    emailError: null,
    spamScore: 0,
  });

  trackEvent("site.form_submitted", "public", "public", {
    site_id: input.siteId,
    origin: normalizedOrigin,
    field_count: Object.keys(sanitized).length,
    had_recipient: true,
  });

  // 10. Fire-and-forget email. We DO NOT await — the response goes back
  //     immediately. The submission row is already saved so worst-case
  //     the designer sees email_status='failed' in the admin UI.
  const rendered = renderEmail({
    payload: sanitized,
    clientName: site.client_slug,
    productName: site.display_name,
    siteId: site.id,
    subjectTemplate: cf.subjectTemplate,
  });
  void sendEmail({
    to: recipient,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
  })
    .then(async () => {
      if (submissionId) {
        await safeQuery(
          `UPDATE apex_site_form_submissions
              SET email_status = 'sent'
            WHERE id = $1`,
          [submissionId],
        );
      }
      trackEvent("site.form_email_sent", "public", "public", {
        site_id: input.siteId,
        submission_id: submissionId ?? "",
      });
    })
    .catch(async (err: unknown) => {
      const msg = (err as Error).message ?? "unknown";
      if (submissionId) {
        await safeQuery(
          `UPDATE apex_site_form_submissions
              SET email_status = 'failed', email_error = $2
            WHERE id = $1`,
          [submissionId, msg.slice(0, 500)],
        ).catch(() => {});
      }
      trackEvent("site.form_email_failed", "public", "public", {
        site_id: input.siteId,
        submission_id: submissionId ?? "",
        error: msg.slice(0, 200),
      });
    });

  return {
    ok: true,
    reason: "ok",
    submissionId: submissionId ?? undefined,
    fieldCount: Object.keys(sanitized).length,
    acceptedOrigin: normalizedOrigin,
  };
}

/**
 * Strip the honeypot field and trim every string before we persist.
 * Keeps the payload bounded + the audit row clean.
 */
function sanitizePayload(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v.slice(0, MAX_FIELD_LENGTH);
  }
  return out;
}

interface PersistArgs {
  siteId: string;
  payload: Record<string, string>;
  origin: string;
  ipHash: string;
  userAgent: string | null;
  recipientEmail: string;
  emailStatus: "pending" | "sent" | "failed" | "throttled";
  emailError: string | null;
  spamScore: number;
}

/**
 * Insert a submission row and return its id. Uses randomUUID so the id
 * is available before the INSERT completes (so the fire-and-forget
 * email update can refer to it). On a safeQuery failure (shadow mode
 * etc.) we return null — the caller keeps going so the HTTP response
 * still succeeds; the analytics event + log line carry enough signal
 * for ops to diagnose.
 */
async function persistSubmission(args: PersistArgs): Promise<string | null> {
  const id = randomUUID();
  try {
    await safeQuery(
      `INSERT INTO apex_site_form_submissions
         (id, site_id, payload, origin, ip_hash, user_agent,
          recipient_email, email_status, email_error, spam_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        args.siteId,
        JSON.stringify(args.payload),
        args.origin,
        args.ipHash,
        args.userAgent,
        args.recipientEmail,
        args.emailStatus,
        args.emailError,
        args.spamScore,
      ],
    );
    return id;
  } catch (err) {
    console.warn(
      "[site-forms] persistSubmission failed:",
      (err as Error).message,
    );
    return null;
  }
}
