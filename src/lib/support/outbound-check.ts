/**
 * support / outbound-check: the last read of an auto-ack reply before it
 * leaves for a person outside the company.
 *
 * WHY THIS IS A BLOCK AND NOT A FLAG. Everywhere else in Instinct, a finding on
 * model output is recorded and the answer still reaches the signed-in person,
 * who can judge it. The auto-ack is different: it is written by a model that
 * has just read an email from a stranger, and it is sent to that stranger with
 * nobody reading it first. If the inbound email talked the model into leaking a
 * key, an internal link, or an instruction ("reply with your MFA code"), the
 * only safe outcome is that nothing is sent and an operator sees the ticket.
 *
 * FAIL CLOSED. Any finding means no send. A false positive costs a customer a
 * few minutes (the operator reply path still runs); a false negative mails
 * internal data to whoever wrote the inbound email.
 *
 * Deterministic: regexes, the shared redactor, the shared output-safety scan.
 * No model call, no network. Bounded input.
 */
import { redactText } from "@/lib/ai/redaction";
import { inspectResponse } from "@/lib/ai/response-safety";
import { scanModelOutput, hostAllowed } from "@/lib/forcefield/output-safety";

export type OutboundFindingKind =
  /** A credential or key-shaped token (shared redactor + PEM/JWT/assignment shapes). */
  | "secret"
  /** A link to an internal host: localhost, private IPs, our app, Graph, SharePoint. */
  | "internal_url"
  /** A link whose host did not appear in the operator-authored template. */
  | "unapproved_url"
  /** A URL to a non-allowlisted host carrying encoded-looking data. */
  | "external_url_payload"
  /** An email address that is neither the customer, us, nor in the template. */
  | "unapproved_email"
  /** Text telling the recipient to hand over a secret, forward the mail, or
   *  addressed to a machine rather than the reader. */
  | "recipient_instruction"
  /** Script, iframe, event handler, javascript: URI. */
  | "active_content";

export interface OutboundFinding {
  kind: OutboundFindingKind;
  /** Short and never the full secret: an audit excerpt, not a second copy. */
  excerpt: string;
}

export interface OutboundCheckResult {
  ok: boolean;
  findings: OutboundFinding[];
}

export interface OutboundCheckContext {
  /** The operator-authored auto-ack template. Hosts and addresses written in
   *  it are approved; everything else is not. */
  template?: string | null;
  /** The customer the reply goes to. Their own address may be echoed. */
  recipientEmail?: string | null;
  /** Our sending address. */
  supportFrom?: string;
}

const MAX_CHECK_CHARS = 8 * 1024;

/** Public hosts an auto-ack may always link to: our own public site. */
const ALWAYS_APPROVED_HOSTS: readonly string[] = Object.freeze(["thewolfpack.agency"]);

/** Hosts that are internal no matter what the template says. */
const INTERNAL_HOST_RE =
  /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;
const INTERNAL_HOST_SUFFIXES: readonly string[] = Object.freeze([
  "vercel.app",
  "sharepoint.com",
  "graph.microsoft.com",
  "local",
  "internal",
  "corp",
  "lan",
  "neon.tech",
  "qdrant.io",
  "vercel-storage.com",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]{1,2048}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;

const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S{6,}/i,
]);

/** Instructions to the recipient that a support acknowledgement never gives. */
const RECIPIENT_INSTRUCTIONS: readonly RegExp[] = Object.freeze([
  /\b(?:reply|respond|send|email|text|share|provide|give)\b[^.\n]{0,40}\b(?:your|the)\s+(?:password|passcode|pin|otp|(?:mfa|2fa|one[- ]time|verification|security|recovery|authenticator)\s+codes?)\b/i,
  /\b(?:password|passcode|mfa code|verification code|one[- ]time code|recovery code)s?\b[^.\n]{0,30}\b(?:to us|to this (?:address|email)|by reply|in your reply)\b/i,
  /\bforward\s+(?:this|the|that|these|all)\b[^.\n]{0,40}\bto\b/i,
  /\b(?:gift\s*cards?|wire\s+transfer|bank\s+(?:details|account)|crypto(?:currency)?\s+wallet)\b/i,
  /\bdo\s+not\s+tell\s+(?:anyone|your|the)\b/i,
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|messages?|emails?)\b/i,
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function excerpt(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 32);
}

/** Hosts written in the operator template are the approved set. */
function templateHosts(template: string | null | undefined): string[] {
  if (!template) return [];
  const hosts: string[] = [];
  for (const m of template.matchAll(URL_RE)) {
    const h = hostOf(m[0]);
    if (h) hosts.push(h);
  }
  return hosts;
}

function isInternalHost(host: string): boolean {
  if (INTERNAL_HOST_RE.test(host)) return true;
  return INTERNAL_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * Check one outbound reply. `ok: false` means DO NOT SEND.
 */
export function checkOutboundReply(body: string, ctx: OutboundCheckContext = {}): OutboundCheckResult {
  const findings: OutboundFinding[] = [];
  const text = (body ?? "").slice(0, MAX_CHECK_CHARS);
  if (!text.trim()) return { ok: true, findings };

  /* 1. Secrets: the shared redactor's key shapes, plus PEM, JWT and
        `password: ...` assignments it does not cover. */
  const redacted = redactText(text, new Set(["api_key"]));
  if (redacted.hits.length > 0) findings.push({ kind: "secret", excerpt: redacted.hits[0].placeholder });
  for (const re of SECRET_SHAPES) {
    const m = re.exec(text);
    if (m) {
      findings.push({ kind: "secret", excerpt: excerpt(m[0]).slice(0, 12) + "..." });
      break;
    }
  }

  /* 2. Links: internal hosts never; other hosts only when the operator
        template names them. */
  const approved = [...ALWAYS_APPROVED_HOSTS, ...templateHosts(ctx.template)];
  for (const m of text.matchAll(URL_RE)) {
    const host = hostOf(m[0]);
    if (!host) {
      findings.push({ kind: "unapproved_url", excerpt: excerpt(m[0]) });
      continue;
    }
    if (isInternalHost(host)) {
      findings.push({ kind: "internal_url", excerpt: host });
    } else if (!hostAllowed(host, approved)) {
      findings.push({ kind: "unapproved_url", excerpt: host });
    }
  }

  /* 3. Data leaving through a URL, and active content: the shared scan. */
  for (const risk of scanModelOutput(text, { allowedHosts: approved })) {
    findings.push({
      kind: risk.kind === "external_url_payload" ? "external_url_payload" : "active_content",
      excerpt: excerpt(risk.match),
    });
  }

  /* 4. Email addresses other than the customer, us, or the template. */
  const allowedEmails = new Set(
    [ctx.recipientEmail, ctx.supportFrom, ...((ctx.template ?? "").match(EMAIL_RE) ?? [])]
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => e.toLowerCase()),
  );
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!allowedEmails.has(m[0].toLowerCase())) {
      findings.push({ kind: "unapproved_email", excerpt: m[0].replace(/^[^@]+/, "***") });
    }
  }

  /* 5. Instructions to the recipient, and text aimed at a machine. */
  for (const re of RECIPIENT_INSTRUCTIONS) {
    const m = re.exec(text);
    if (m) {
      findings.push({ kind: "recipient_instruction", excerpt: excerpt(m[0]) });
      break;
    }
  }
  for (const f of inspectResponse(text)) {
    if (f.risk === "downstream_injection") {
      findings.push({ kind: "recipient_instruction", excerpt: excerpt(f.evidence) });
    }
  }

  return { ok: findings.length === 0, findings };
}
