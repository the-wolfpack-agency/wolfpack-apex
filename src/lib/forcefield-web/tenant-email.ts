/**
 * Tenant-facing Forcefield emails (pure renderers, no IO):
 *   - the double opt-in confirmation ("Confirm alerts for <site>"),
 *   - the "first hour" email (sent once, shortly after the first real visitors),
 *   - the daily digest for one tenant's site,
 *   - the footer appended to a tenant's immediate alert (rendered by the shared
 *     alert template with audience "tenant").
 *
 * Every tenant email links to the tenant's client dashboard only (never /admin)
 * and carries one unsubscribe link. Every field is HTML-escaped; every link is
 * absolute, built from the base URL passed in. Sending is NOT done here: the
 * caller hands the result to sendForcefieldTenantMail (tenant-mail.ts), which
 * enforces the recipient allowlist.
 */
import { escapeHtml } from "@/lib/forcefield-web/alert-email";

export interface RenderedTenantEmail {
  subject: string;
  html: string;
  text: string;
  links: { label: string; href: string }[];
}

export interface TenantEmailLinks {
  /** Absolute base URL, no trailing slash. */
  baseUrl: string;
  /** Signed unsubscribe token for this tenant + address. */
  unsubscribeToken: string;
}

const C = { ink: "#1f2328", muted: "#57606a", line: "#d0d7de", brand: "#0b0d11", gold: "#e8b528", link: "#0b57d0" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function dashboardUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/forcefield/dashboard`;
}
export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/forcefield/unsubscribe?token=${encodeURIComponent(token)}`;
}
export function confirmUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/forcefield/confirm?token=${encodeURIComponent(token)}`;
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td bgcolor="${C.gold}" style="background:${C.gold};border-radius:6px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:14px;font-weight:600;color:${C.brand};text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`;
}

interface Shell {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  rows?: { label: string; value: string }[];
  cta: { label: string; href: string };
  footer: string[];
  footerLinks: { label: string; href: string }[];
}

function render(s: Shell): RenderedTenantEmail {
  const e = escapeHtml;
  const rows = (s.rows ?? []).map((r) => `<tr><td style="padding:8px 12px 8px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;color:${C.muted};white-space:nowrap;">${e(r.label)}</td><td style="padding:8px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;color:${C.ink};">${e(r.value)}</td></tr>`).join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(s.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(s.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:8px;">
<tr><td bgcolor="${C.brand}" style="background:${C.brand};padding:16px 28px;border-radius:8px 8px 0 0;"><span style="font-family:${FONT};font-size:15px;font-weight:800;letter-spacing:0.12em;color:#ffffff;">OGIAM</span><span style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.gold};padding-left:10px;">Forcefield</span></td></tr>
<tr><td style="padding:24px 28px 0;"><h1 style="margin:0;font-family:${FONT};font-size:21px;line-height:28px;color:${C.ink};">${e(s.heading)}</h1>
${s.paragraphs.map((p) => `<p style="margin:12px 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${C.ink};">${e(p)}</p>`).join("")}</td></tr>
${rows ? `<tr><td style="padding:16px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>` : ""}
<tr><td style="padding:20px 28px 8px;">${button(s.cta.label, s.cta.href)}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${s.footer.map(e).join("<br>")}<br>${s.footerLinks.map((l) => `<a href="${e(l.href)}" style="color:${C.link};">${e(l.label)}</a>`).join(" · ")}</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [
    s.heading,
    "",
    ...s.paragraphs,
    ...(s.rows && s.rows.length ? ["", ...s.rows.map((r) => `${r.label}: ${r.value}`)] : []),
    "",
    `${s.cta.label}: ${s.cta.href}`,
    "",
    "--",
    ...s.footer,
    ...s.footerLinks.map((l) => `${l.label}: ${l.href}`),
  ].join("\n");
  return { subject: s.subject, html, text, links: [s.cta, ...s.footerLinks] };
}

function standardFooter(site: string, to: string, links: TenantEmailLinks): { footer: string[]; footerLinks: { label: string; href: string }[] } {
  return {
    footer: [
      `You receive this because alerts for ${site} are turned on in Forcefield and were confirmed for ${to}.`,
      "Change or remove this address from your Forcefield dashboard.",
    ],
    footerLinks: [
      { label: "Manage alerts", href: dashboardUrl(links.baseUrl) },
      { label: "Unsubscribe", href: unsubscribeUrl(links.baseUrl, links.unsubscribeToken) },
    ],
  };
}

/** The double opt-in email. Only the confirm link turns alerts on. */
export function renderConfirmEmail(input: { site: string; to: string; baseUrl: string; confirmToken: string; expiresHours: number }): RenderedTenantEmail {
  return render({
    subject: `Confirm Forcefield alerts for ${input.site}`,
    preheader: `One click turns on Forcefield alerts for ${input.site}.`,
    heading: `Confirm alerts for ${input.site}`,
    paragraphs: [
      `Someone asked Forcefield to send activity alerts for ${input.site} to ${input.to}.`,
      `Confirm this address and you will get an email when Forcefield first sees traffic on your site, an alert when it catches a hostile agent, and a daily summary.`,
      `This link works for ${input.expiresHours} hours. If you did not ask for this, ignore this email and nothing will be sent.`,
    ],
    cta: { label: "Confirm alerts", href: confirmUrl(input.baseUrl, input.confirmToken) },
    footer: ["You receive this one email because this address was entered on the Forcefield setup page. No alerts are sent until it is confirmed."],
    footerLinks: [{ label: "Forcefield dashboard", href: dashboardUrl(input.baseUrl) }],
  });
}

export interface EvidenceCounts {
  agentsDetected: number;
  welcomed: number;
  hostile: number;
  trapped: number;
  probed: number;
  payloads: number;
}

const n = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0).toLocaleString("en-US");

/** What the first-hour email summarizes (tenant-activity.ts). */
export interface FirstHourActivity {
  counts: { agentsSeen: number; welcomed: number; slowed: number; blocked: number; caught: number };
  agents: { name: string; requests: number; did: string; handled: string }[];
}

const HANDLED_LABEL: Record<string, string> = {
  blocked: "blocked",
  slowed: "slowed down",
  welcomed: "welcomed",
  caught: "caught (watch mode, not blocked)",
  watched: "watched",
};

/** The "first hour" email: sent once, shortly after the first real visitors
 *  reach the site. Counts of agents seen, welcomed, slowed and blocked, the top
 *  few by activity, and the dashboard link. */
export function renderFirstHourEmail(input: { site: string; to: string; firstEventAt: string; activity: FirstHourActivity } & TenantEmailLinks): RenderedTenantEmail {
  const c = input.activity.counts;
  const f = standardFooter(input.site, input.to, input);
  const top = input.activity.agents.slice(0, 3);
  const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
  return render({
    subject: `Your first hour with Forcefield on ${input.site}`,
    preheader: `${plural(c.agentsSeen, "automated agent", "automated agents")} reached ${input.site} so far. Here is what Forcefield did.`,
    heading: `Your first hour on ${input.site}`,
    paragraphs: [
      `Forcefield is connected and saw its first visitor on ${input.site} at ${new Date(input.firstEventAt).toUTCString()}.`,
      c.agentsSeen > 0
        ? `Since then ${plural(c.agentsSeen, "automated agent has", "automated agents have")} visited: ${n(c.welcomed)} welcomed, ${n(c.slowed)} slowed down, ${n(c.blocked)} blocked${c.caught > 0 ? ` and ${n(c.caught)} caught in watch mode` : ""}.`
        : "No automated agents yet, only people. When bots and AI agents arrive, your dashboard shows each one and what Forcefield did.",
      c.caught > 0 && c.blocked === 0
        ? "Forcefield is in watch mode: it records and reports hostile agents but does not block them until you turn blocking on."
        : "Forcefield never blocks a signed-in user or a known-good crawler.",
    ],
    rows: [
      { label: "Agents seen", value: n(c.agentsSeen) },
      { label: "Welcomed", value: n(c.welcomed) },
      { label: "Slowed", value: n(c.slowed) },
      { label: "Blocked", value: n(c.blocked) },
      ...top.map((a) => ({ label: a.name, value: `${plural(a.requests, "request", "requests")}. ${a.did}. ${HANDLED_LABEL[a.handled] ?? a.handled}.` })),
    ],
    cta: { label: "Open your live dashboard", href: dashboardUrl(input.baseUrl) },
    ...f,
  });
}

/** The daily digest for one tenant's site (last 24 hours). */
export function renderTenantDigestEmail(input: { site: string; to: string; day: string; counts: EvidenceCounts; attacks: { attack: string; count: number }[] } & TenantEmailLinks): RenderedTenantEmail {
  const c = input.counts;
  const f = standardFooter(input.site, input.to, input);
  const top = input.attacks.slice(0, 3).map((a) => `${a.attack.replace(/_/g, " ")} (${n(a.count)})`).join(", ");
  return render({
    subject: `Forcefield daily summary for ${input.site}: ${n(c.hostile)} hostile ${c.hostile === 1 ? "action" : "actions"}`,
    preheader: `${n(c.agentsDetected)} automated agents seen on ${input.site} in the last 24 hours.`,
    heading: `${input.site}: the last 24 hours`,
    paragraphs: [
      c.hostile > 0
        ? `Forcefield caught ${n(c.hostile)} hostile ${c.hostile === 1 ? "action" : "actions"} on ${input.site}${top ? `, mostly ${top}` : ""}.`
        : `Forcefield saw ${n(c.agentsDetected)} automated ${c.agentsDetected === 1 ? "agent" : "agents"} on ${input.site} and none were hostile.`,
    ],
    rows: [
      { label: "Day (UTC)", value: input.day },
      { label: "Automated agents seen", value: n(c.agentsDetected) },
      { label: "Good bots welcomed", value: n(c.welcomed) },
      { label: "Hostile actions", value: n(c.hostile) },
      { label: "Honeypot trips", value: n(c.trapped) },
      { label: "Sensitive-path probes", value: n(c.probed) },
      { label: "Payload attacks", value: n(c.payloads) },
    ],
    cta: { label: "Open your Forcefield dashboard", href: dashboardUrl(input.baseUrl) },
    ...f,
  });
}

/**
 * Add the manage + unsubscribe footer to a tenant alert rendered by the shared
 * alert template (audience "tenant"), whose own footer points at "your OGIAM
 * representative". Appended in both the HTML (before </body>) and the text.
 */
export function withTenantFooter<T extends { html: string; text: string; links: { label: string; href: string }[] }>(email: T, site: string, to: string, links: TenantEmailLinks): T {
  const f = standardFooter(site, to, links);
  const e = escapeHtml;
  const block = `<div style="font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};text-align:center;padding:0 12px 24px;">${f.footer.map(e).join("<br>")}<br>${f.footerLinks.map((l) => `<a href="${e(l.href)}" style="color:${C.link};">${e(l.label)}</a>`).join(" · ")}</div>`;
  const html = email.html.includes("</body>") ? email.html.replace("</body>", `${block}\n</body>`) : `${email.html}${block}`;
  const text = `${email.text}\n${f.footer.join("\n")}\n${f.footerLinks.map((l) => `${l.label}: ${l.href}`).join("\n")}`;
  return { ...email, html, text, links: [...email.links, ...f.footerLinks] };
}
