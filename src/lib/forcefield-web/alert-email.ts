/**
 * The Forcefield alert email: ONE shared, enterprise-grade template for every
 * Forcefield alert (incident, canary trip, silence check, block review).
 *
 * Pure and deterministic: given an alert and a base URL it returns the subject,
 * a table-based HTML body with inline CSS (renders in Outlook, Gmail and mobile
 * clients; no external images, fonts or trackers) and a complete plain-text
 * alternative carrying the same facts and links.
 *
 * Two audiences:
 *   - "operator": the Wolfpack security owner. Admin deep links, fingerprints,
 *     the automatic-block decision, the alert id and dedupe key.
 *   - "tenant": a client's view of their OWN site (dashboard links only, no
 *     /admin URLs, no internal ids). BUILD PHASE: this renderer exists for
 *     previews only. No delivery path calls it, and a guardrail test
 *     (alert-delivery-guardrail.test.ts) fails the build if one does.
 *
 * Every field is HTML-escaped; every link is absolute (built from the base URL
 * passed in, never hard-coded).
 */
import type { ForcefieldAlert } from "@/lib/forcefield-web/alerts";
import { boardHref } from "@/lib/forcefield-web/board-link";
import { siteHost } from "@/lib/forcefield-web/site-host";
import { attackAim, attackLabel } from "@/lib/forcefield-web/attack-labels";
import type { ClassLine, DigestData } from "@/lib/forcefield-web/incidents";

/* --------------------------------- types ---------------------------------- */

/** What happened to the automatic fingerprint block for an incident. */
export interface BlockDecision {
  /** blocked: an automatic block was written; withheld: refused because the
   *  fingerprint is shared by legitimate visitors; none: no automatic block was
   *  recorded (automatic blocking off, or not applicable). */
  state: "blocked" | "withheld" | "none";
  fingerprints: string[];
  /** Stable reason id for a withheld block (common_client_kind, ...). */
  why?: string;
  /** For a written block: when it expires (ISO). */
  expiresAt?: string;
}

/** The facts of one incident (one site + one attack class + one window). */
export interface IncidentDetail {
  /** Exact first and last event times (ISO). */
  firstAt: string;
  lastAt: string;
  count: number;
  windowStart: string;
  windowHours: number;
  /** Distinct paths (capped) and the full distinct count. */
  paths: string[];
  pathCount: number;
  countries: string[];
  hosting: string[];
  clientTypes: string[];
  /** Identified agent names; "unidentified" is filtered out at render. */
  agents: string[];
  /** Network owner (org / ASN) when the edge recorded one. */
  networks: string[];
  fingerprints: string[];
  fingerprintCount: number;
  signatures: string[];
  signatureCount: number;
  /** Per-request outcome counts. */
  outcomes: { blocked: number; contained: number; recorded: number };
  postures: string[];
  /** decoy | honeytoken | payload ... (the engine's reason kind). */
  reasonKinds: string[];
  blockDecision?: BlockDecision;
}

export type AlertAudience = "operator" | "tenant";

export interface RenderOptions {
  audience: AlertAudience;
  /** Absolute base URL, e.g. https://wolfpack-instinct.vercel.app (no slash). */
  baseUrl: string;
  /** Everyone this email goes to (shown in the footer). */
  recipients: string[];
  /** Operator footer: the alert row id. */
  alertId?: string;
  /** Tenant version: the client's display name for their site. */
  tenantName?: string;
}

export interface RenderedAlertEmail {
  subject: string;
  html: string;
  text: string;
  /** Every absolute link the email carries (for tests + audit). */
  links: { label: string; href: string }[];
}

/* ------------------------------- formatting ------------------------------- */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-26 10:05:37 UTC". Exact to the second; never rounded to a window. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "time not recorded";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** "Oct 26, 2026, 6:05:37 AM EDT" (US Eastern, DST-aware). */
export function formatEastern(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "long" }).format(d);
}

function formatWhen(iso: string): string {
  const et = formatEastern(iso);
  return et ? `${formatUtc(iso)} (${et})` : formatUtc(iso);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return code;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    const name = regionNames.of(c);
    return name && name !== c ? `${name} (${c})` : c;
  } catch {
    return c;
  }
}

const CLIENT_TYPE_LABEL: Record<string, string> = {
  browser: "browser-like client",
  headless: "headless browser",
  scripted_library: "script or HTTP library",
  known_crawler: "known crawler",
  ai_agent: "AI agent",
  unknown: "unrecognized client",
};
const HOSTING_LABEL: Record<string, string> = {
  residential: "residential network",
  datacenter: "datacenter / cloud network",
  mobile: "mobile network",
  unknown: "network type not recorded",
};

/** The site as a reader knows it: the hostname, never the internal label
 *  ("instinct" -> wolfpack-instinct.vercel.app). Falls back to the label. */
export function displaySite(label: string | undefined): string {
  return label ? siteHost(label) || label : "";
}

const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ------------------------------ the semantics ----------------------------- */

export type ResponseKind = "blocked" | "contained" | "recorded" | "partial" | "unknown";

/** What the edge did, across every request in the incident. */
export function responseKind(i: IncidentDetail | undefined): ResponseKind {
  if (!i) return "unknown";
  const { blocked, contained, recorded } = i.outcomes;
  const total = blocked + contained + recorded;
  if (total === 0) return "unknown";
  if (recorded === 0 && contained === 0) return "blocked";
  if (recorded === 0) return "contained";
  if (blocked === 0 && contained === 0) return "recorded";
  return "partial";
}

/** "decoy" or "honeytoken": the word used for a trap trip. */
function trapNoun(i: IncidentDetail | undefined): "decoy" | "honeytoken" {
  return i?.reasonKinds.includes("honeytoken") && !i.reasonKinds.includes("decoy") ? "honeytoken" : "decoy";
}

function actorPhrase(i: IncidentDetail | undefined): { one: boolean; noun: string } {
  const actors = i ? Math.max(i.signatureCount, i.fingerprintCount, 1) : 1;
  return { one: actors <= 1, noun: actors <= 1 ? "hostile agent" : "hostile agents" };
}

const OUTCOME_WORD: Record<ResponseKind, string> = {
  blocked: "blocked",
  contained: "contained",
  recorded: "recorded, not blocked",
  partial: "partly stopped",
  unknown: "detected",
};

export type Severity = "Critical" | "High" | "Warning" | "Review" | "Info";

export function alertSeverity(alert: ForcefieldAlert): Severity {
  switch (alert.kind) {
    case "canary_trip": return "Critical";
    case "honeytoken_trip":
    case "payload_attack":
    case "hostile_incident": return "High";
    case "alert_digest": return "Info";
    case "alert_silence": return "Warning";
    default: return "Review";
  }
}

/**
 * A grouped incident (hostile_incident) reads like the single-class kinds:
 * a burst with a trap trip reads as a trap trip, anything else as a payload
 * attack. The class list itself is rendered as its own table.
 */
function effectiveKind(alert: ForcefieldAlert): ForcefieldAlert["kind"] {
  if (alert.kind !== "hostile_incident") return alert.kind;
  return alert.attention?.includes("decoy") || alert.classes?.some((c) => c.kind === "honeytoken_trip") ? "honeytoken_trip" : "payload_attack";
}

/** Payload classes of a grouped incident (trap trips excluded). */
function payloadClasses(alert: ForcefieldAlert): ClassLine[] {
  return (alert.classes ?? []).filter((c) => c.kind === "payload_attack");
}

/** "SQL injection" for one class, "3 attack types" for several. */
function classesPhrase(alert: ForcefieldAlert): string {
  const p = payloadClasses(alert);
  if (alert.kind !== "hostile_incident" || p.length === 0) return attackLabel(alert.attackClass ?? "payload attack");
  return p.length === 1 ? attackLabel(p[0].attackClass) : `${p.length} attack types`;
}

/** The outcome-first subject line. */
export function alertSubject(alert: ForcefieldAlert): string {
  if (alert.kind === "alert_digest" && alert.digest) return digestSubject(alert.digest);
  const site = displaySite(alert.site) || "Forcefield";
  const i = alert.incident;
  const r = responseKind(i);
  const kind = effectiveKind(alert);
  if (kind === "honeytoken_trip") {
    const extra = payloadClasses(alert).length;
    return `[Forcefield] ${site}: ${actorPhrase(i).noun} ${OUTCOME_WORD[r]} (${trapNoun(i)}${extra > 0 ? `, plus ${plural(extra, "attack type")}` : ""})`;
  }
  if (kind === "payload_attack") {
    const what = cap1(classesPhrase(alert));
    const n = i?.count ?? (Number(alert.metadata?.count) || 0);
    return `[Forcefield] ${site}: ${what} ${OUTCOME_WORD[r]}${n > 0 ? ` (${plural(n, "attempt")})` : ""}`;
  }
  if (alert.kind === "alert_silence") return "[Forcefield] Alerting check failed: hostile traffic with no alert delivered";
  if (alert.kind === "autoblock_withheld") return "[Forcefield] Review: automatic block withheld for a shared fingerprint";
  // canary_trip and anything newer: the alert's own title, outcome first.
  return `[Forcefield] ${alert.title.replace(/^Forcefield:\s*/, "")}`;
}

/** The one-line headline, in plain words. */
export function alertHeadline(alert: ForcefieldAlert): string {
  if (alert.kind === "alert_digest" && alert.digest) return digestHeadline(alert.digest);
  const site = displaySite(alert.site) || "a connected site";
  const i = alert.incident;
  const r = responseKind(i);
  const kind = effectiveKind(alert);
  if (kind === "honeytoken_trip") {
    const a = actorPhrase(i);
    // Lead with what Forcefield did, in the reader's terms; the outcome is exact.
    const who = a.one ? "an automated attacker" : `${plural(Math.max(i?.signatureCount ?? 0, i?.fingerprintCount ?? 0), "automated attacker")}`;
    const it = a.one ? "it" : "them";
    if (r === "contained") return `Forcefield caught ${who} on ${site} and kept ${it} away from your real pages`;
    if (r === "blocked") return `Forcefield caught ${who} on ${site} and turned ${it} away`;
    if (r === "recorded") return `Forcefield caught ${who} on ${site}; it was recorded, not blocked`;
    if (r === "partial") return `Forcefield caught ${who} on ${site}; some requests were stopped, some only recorded`;
    return `Forcefield caught ${who} on ${site}`;
  }
  if (kind === "payload_attack") {
    const multi = alert.kind === "hostile_incident" && payloadClasses(alert).length > 1;
    const what = multi ? "attack" : attackLabel(alert.kind === "hostile_incident" ? payloadClasses(alert)[0]?.attackClass ?? "payload" : alert.attackClass ?? "payload");
    const n = i?.count ?? 1;
    if (multi) {
      const lead = `${n.toLocaleString("en-US")} attack attempts across ${payloadClasses(alert).length} attack types on ${site}`;
      if (r === "blocked" || r === "contained") return `Forcefield stopped ${lead}`;
      if (r === "recorded") return `${lead} were recorded, not blocked`;
      if (r === "partial") return `${lead}: some were blocked, some only recorded`;
      return `${lead} were detected`;
    }
    const lead = n === 1 ? `A ${what} attack on ${site}` : `${n.toLocaleString("en-US")} ${what} attempts on ${site}`;
    const verb = n === 1 ? "was" : "were";
    if (r === "blocked" || r === "contained") return `Forcefield stopped ${n === 1 ? `a ${what} attack` : `${n.toLocaleString("en-US")} ${what} attempts`} on ${site}`;
    if (r === "recorded") return `${lead} ${verb} recorded, not blocked`;
    if (r === "partial") return `${lead}: some were blocked, some only recorded`;
    return `${lead} ${verb} detected`;
  }
  if (alert.kind === "alert_silence") return "Hostile traffic arrived but no Forcefield alert reached anyone";
  if (alert.kind === "autoblock_withheld") return "An automatic block was withheld and needs your review";
  return alert.title.replace(/^Forcefield:\s*/, "");
}

interface StatusBlock {
  tone: "good" | "warn" | "bad" | "info";
  status: string;
  action: string;
}

function statusBlock(alert: ForcefieldAlert, audience: AlertAudience): StatusBlock {
  const i = alert.incident;
  if (alert.kind === "alert_digest" && alert.digest) return digestStatus(alert.digest);
  if (alert.kind === "alert_silence") {
    return { tone: "bad", status: "Alert delivery is failing", action: "Action needed: check the forcefield-alerts cron and the Microsoft Graph mail settings." };
  }
  if (alert.kind === "autoblock_withheld") {
    return { tone: "warn", status: "Automatic block withheld (recorded only)", action: "Recommended: review the operator on the board and block it explicitly if a tool-wide block is warranted." };
  }
  if (alert.kind === "canary_trip") {
    return { tone: "bad", status: "Decoy credential or record touched", action: "Recommended: review the client on the board. Nothing legitimate reaches a decoy." };
  }
  const r = responseKind(i);
  const o = i?.outcomes ?? { blocked: 0, contained: 0, recorded: 0 };
  const watchAction = audience === "tenant"
    ? "Recommended: turn on blocking for your site so requests like this are stopped automatically. Your OGIAM contact can enable it."
    : "Recommended: review this activity on the board. If this site should stop such traffic, switch it from watch to enforce.";
  switch (r) {
    case "contained":
      return {
        tone: "good",
        status: o.blocked > 0 ? `Contained: ${plural(o.contained, "request")} sent into the decoy maze, ${o.blocked.toLocaleString("en-US")} blocked` : "Contained: sent into the decoy maze",
        action: "No action needed.",
      };
    case "blocked":
      return { tone: "good", status: o.blocked === 1 ? "Blocked at the edge" : `Blocked at the edge (${plural(o.blocked, "request")})`, action: "No action needed." };
    case "recorded":
      return { tone: "warn", status: "Recorded only: the site is in watch mode, so the request was not blocked", action: watchAction };
    case "partial":
      return {
        tone: "warn",
        status: `Partly stopped: ${o.blocked.toLocaleString("en-US")} blocked, ${o.contained.toLocaleString("en-US")} sent into the decoy maze, ${o.recorded.toLocaleString("en-US")} recorded only`,
        action: watchAction,
      };
    default:
      return { tone: "info", status: "Detected", action: audience === "tenant" ? "No action needed." : "Recommended: review this activity on the board." };
  }
}

/**
 * "What Forcefield did for you": what it spotted, what it did, and what that
 * means for the site, in the reader's words. Every sentence follows the actual
 * outcome: a request that was only recorded (watch mode) is never described as
 * stopped, and "not affected" is said only when every request was stopped.
 * Empty for alert kinds that are not about a visitor (delivery checks, reviews).
 */
export function benefitLines(alert: ForcefieldAlert): string[] {
  const i = alert.incident;
  const kind = effectiveKind(alert);
  const r = responseKind(i);
  const o = i?.outcomes ?? { blocked: 0, contained: 0, recorded: 0 };
  const stoppedAll = r === "blocked" || r === "contained";
  if (kind === "honeytoken_trip") {
    const a = actorPhrase(i);
    const spotted = trapNoun(i) === "honeytoken"
      ? `Spotted ${a.one ? "a program" : "programs"} using a fake credential we planted, which only someone who harvested it from our decoys could have.`
      : `Spotted ${a.one ? "an automated program" : "automated programs"} reaching for a hidden link that no real visitor can see, a sure sign of hunting for weaknesses.`;
    const did =
      r === "contained" ? `Sent ${a.one ? "it" : "them"} into a maze of fake pages, so the time was wasted there instead of on your real site.`
      : r === "blocked" ? `Turned ${a.one ? "it" : "them"} away before reaching your site.`
      : r === "partial" ? `Stopped ${(o.blocked + o.contained).toLocaleString("en-US")} of the requests; ${o.recorded.toLocaleString("en-US")} were only recorded because the site was in watch mode.`
      : r === "recorded" ? "Your site is in watch mode, so Forcefield recorded this but did not stop it."
      : "Recorded the activity for review.";
    return stoppedAll ? [spotted, did, "Your pages, your data and your visitors were not affected."] : [spotted, did];
  }
  if (kind === "payload_attack") {
    const classes = payloadClasses(alert);
    const n = i?.count ?? 1;
    const attempts = n === 1 ? "an attempt" : `${n.toLocaleString("en-US")} attempts`;
    const aim = classes.length > 1
      ? `break into your site in ${classes.length} different ways`
      : attackAim(alert.kind === "hostile_incident" ? classes[0]?.attackClass ?? "payload" : alert.attackClass ?? "payload");
    const spotted = `Recognized ${attempts} to ${aim}.`;
    const did =
      stoppedAll ? `Turned ${n === 1 ? "it" : "every one"} away before ${n === 1 ? "it" : "they"} reached your site.`
      : r === "partial" ? `Stopped ${(o.blocked + o.contained).toLocaleString("en-US")} of them; ${o.recorded.toLocaleString("en-US")} were only recorded because the site was in watch mode.`
      : r === "recorded" ? "Your site is in watch mode, so these were recorded, not stopped."
      : "Recorded the activity for review.";
    return stoppedAll ? [spotted, did, "Nothing reached your pages or your data, so there is nothing for you to fix."] : [spotted, did];
  }
  return [];
}

/** One plain sentence on what the signal is and why it is trusted. */
function signalExplanation(alert: ForcefieldAlert): { signal: string; confidence: string; explain: string } | null {
  const i = alert.incident;
  const kind = effectiveKind(alert);
  if (kind === "honeytoken_trip") {
    const noun = trapNoun(i);
    return {
      signal: noun === "honeytoken" ? "Honeytoken used" : "Decoy taken",
      confidence: "High: proven hostile",
      explain: noun === "honeytoken"
        ? "A honeytoken is a planted value with no legitimate use, so any request that presents one is hostile by definition."
        : "A decoy is a link or record hidden from people and never offered to them, so only an automated agent acting on content it should not touch can reach it.",
    };
  }
  if (kind === "payload_attack") {
    return {
      signal: alert.kind === "hostile_incident" && payloadClasses(alert).length > 1
        ? `Attack payloads (${payloadClasses(alert).length} types)`
        : `${cap1(classesPhrase(alert))} payload`,
      confidence: "High: rule match on a live attack payload",
      explain: "The request carried an attack payload aimed at the site's inputs; payload rules match the attack itself, not a guess about the visitor.",
    };
  }
  return null;
}

const WITHHELD_WHY: Record<string, string> = {
  common_client_kind: "this client fingerprint is shared by many legitimate visitors",
  legacy_no_kind: "this fingerprint has no client part, so it cannot single out one client",
  shared_header_shape: "this header shape is shared by several unrelated clients",
  wide_country_spread: "this fingerprint appears from many countries",
  spread_unavailable: "how widely this fingerprint is shared could not be measured",
};

function blockDecisionText(d: BlockDecision | undefined, clientType: string | undefined): { title: string; text: string } | null {
  if (!d) return null;
  if (d.state === "withheld") {
    const why = (d.why ?? "").split(",").map((w) => WITHHELD_WHY[w.trim()]).filter(Boolean)[0]
      ?? "this fingerprint is shared by legitimate visitors";
    const kind = clientType === "browser" ? "browser fingerprint" : "fingerprint";
    return {
      title: "Why we did not block this visitor everywhere",
      text: `${cap1(why.replace("this client fingerprint", `this ${kind}`))}, so blocking it everywhere would turn real people away. Forcefield still stops every harmful request this visitor sends. Block the operator from the board only if a tool-wide block is warranted.`,
    };
  }
  if (d.state === "blocked") {
    return {
      title: "Blocked on every protected site",
      text: `This visitor is now turned away on every site Forcefield protects${d.expiresAt ? `, until ${formatUtc(d.expiresAt)}` : ""}. The block expires on its own; you can lift it from the board at any time.`,
    };
  }
  return {
    title: "No automatic block recorded",
    text: "No automatic fingerprint block was written for this client (automatic blocking is off or did not apply). The per-request rules above still applied.",
  };
}

/* ------------------------------ details table ----------------------------- */

interface Row { label: string; value: string; mono?: boolean }

function listWithMore(items: string[], total: number): string {
  if (items.length === 0) return "not recorded";
  const more = total - items.length;
  return items.join(", ") + (more > 0 ? ` and ${more.toLocaleString("en-US")} more` : "");
}

function sourceLine(i: IncidentDetail): string {
  const parts: string[] = [];
  parts.push(i.countries.length ? i.countries.map(countryName).join(", ") : "Country not recorded");
  const net = i.hosting.map((h) => HOSTING_LABEL[h] ?? `${h.replace(/_/g, " ")} network`);
  if (i.networks.length) parts.push(`${net.length ? `${net.join(", ")}, ` : ""}${i.networks.join(", ")}`);
  else if (net.length) parts.push(net.join(", "));
  if (i.clientTypes.length) parts.push(i.clientTypes.map((c) => CLIENT_TYPE_LABEL[c] ?? c.replace(/_/g, " ")).join(", "));
  const named = i.agents.filter((a) => a && a !== "unidentified" && a !== "unknown");
  parts.push(named.length ? `identified as ${named.join(", ")}` : "agent not identified");
  return parts.join(" · ");
}

function detailRows(alert: ForcefieldAlert, audience: AlertAudience, tenantName?: string): Row[] {
  const i = alert.incident;
  const rows: Row[] = [];
  const site = displaySite(alert.site);
  rows.push({ label: "Site", value: site ? (tenantName && audience === "tenant" ? `${site} (${tenantName})` : site) : "Not site-specific" });
  if (i) {
    if (i.firstAt === i.lastAt || i.count <= 1) {
      rows.push({ label: "When", value: formatWhen(i.firstAt) });
    } else {
      rows.push({ label: "First event", value: formatWhen(i.firstAt) });
      rows.push({ label: "Last event", value: formatWhen(i.lastAt) });
    }
    rows.push({ label: "Requests", value: i.count.toLocaleString("en-US") });
    rows.push({ label: i.pathCount === 1 ? "Path" : "Paths", value: listWithMore(i.paths, i.pathCount), mono: true });
    rows.push({ label: "Source", value: sourceLine(i) });
    const sig = signalExplanation(alert);
    if (sig) {
      rows.push({ label: "Signal", value: sig.signal });
      rows.push({ label: "Confidence", value: sig.confidence });
    }
    const posture = i.postures.length ? i.postures.map((p) => (p === "enforce" ? "Enforce (blocking on)" : p === "monitor" ? "Watch (recording only)" : p)).join(", ") : "";
    if (posture) rows.push({ label: "Site mode", value: posture });
    if (audience === "operator") {
      rows.push({ label: i.fingerprintCount === 1 ? "Fingerprint" : "Fingerprints", value: i.fingerprintCount > 0 ? listWithMore(i.fingerprints, i.fingerprintCount) : "not recorded", mono: true });
      rows.push({ label: i.signatureCount === 1 ? "Session signature" : "Session signatures", value: i.signatureCount > 0 ? listWithMore(i.signatures, i.signatureCount) : "not recorded", mono: true });
    }
    const end = new Date(new Date(i.windowStart).getTime() + i.windowHours * 3600_000).toISOString();
    rows.push({ label: "Alert window", value: `Grouped with other events from ${formatUtc(i.windowStart).replace(" UTC", "")} to ${formatUtc(end)} (context only)` });
  } else {
    if (alert.windowStart) rows.push({ label: "Window", value: formatWhen(alert.windowStart) });
    rows.push({ label: "Details", value: alert.body });
  }
  return rows;
}

/* --------------------------------- links ---------------------------------- */

interface Link { label: string; href: string }

function linksFor(alert: ForcefieldAlert, opts: RenderOptions): { primary: Link; secondary: Link[] } {
  const base = opts.baseUrl.replace(/\/$/, "");
  if (opts.audience === "tenant") {
    return {
      primary: { label: "Open your Forcefield dashboard", href: `${base}/forcefield/dashboard` },
      secondary: [{ label: "Forcefield status", href: `${base}/forcefield/status` }],
    };
  }
  const docs = { label: "What this alert means", href: `${base}/admin/forcefield/docs?doc=alerts` };
  if (alert.kind === "alert_digest") {
    return { primary: { label: "Open the Forcefield board", href: `${base}${boardHref({ tab: "forcefield", days: 7 })}` }, secondary: [docs] };
  }
  const i = alert.incident;
  if (alert.kind === "hostile_incident") {
    // A burst usually spans many sessions: land on the site's board, narrowed to
    // the session only when the burst is one session.
    const site = alert.site ? { site: alert.site } : {};
    const find = i && i.signatureCount === 1 ? { find: i.signatures[0] } : {};
    return {
      primary: { label: "Open this incident on the board", href: `${base}${boardHref({ tab: "forcefield", view: "operator", days: 7, ...site, ...find })}` },
      secondary: [{ label: "Forcefield board", href: `${base}${boardHref({ tab: "forcefield" })}` }, docs],
    };
  }
  // Land on THIS incident: the exact session signature when there is one (the
  // board's journey key), else the path, else the operator view.
  const find = i && i.signatureCount === 1 ? i.signatures[0] : i && i.pathCount === 1 ? i.paths[0] : i?.paths[0];
  return {
    primary: { label: alert.incident ? "Open this incident on the board" : "Open the Forcefield board", href: `${base}${boardHref({ tab: "forcefield", view: "operator", ...(find ? { find } : {}) })}` },
    secondary: [{ label: "Forcefield board", href: `${base}${boardHref({ tab: "forcefield" })}` }, docs],
  };
}

/* --------------------------------- render ---------------------------------- */

const C = {
  ink: "#1f2328",
  muted: "#57606a",
  line: "#d0d7de",
  soft: "#f6f8fa",
  brandBg: "#0b0d11",
  gold: "#e8b528",
  link: "#0b57d0",
};
const TONE: Record<StatusBlock["tone"], { bg: string; border: string; ink: string }> = {
  good: { bg: "#ecfdf3", border: "#75e0a7", ink: "#054f31" },
  warn: { bg: "#fffaeb", border: "#fec84b", ink: "#7a2e0e" },
  bad: { bg: "#fef3f2", border: "#fda29b", ink: "#7a271a" },
  info: { bg: "#eff8ff", border: "#84caff", ink: "#194185" },
};
const SEV: Record<Severity, { bg: string; ink: string }> = {
  Critical: { bg: "#7a271a", ink: "#ffffff" },
  High: { bg: "#b42318", ink: "#ffffff" },
  Warning: { bg: "#b54708", ink: "#ffffff" },
  Review: { bg: "#344054", ink: "#ffffff" },
  Info: { bg: "#175cd3", ink: "#ffffff" },
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";

function button(label: string, href: string, primary: boolean): string {
  const bg = primary ? C.gold : "#ffffff";
  const border = primary ? C.gold : C.line;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;display:inline-table;margin:0 8px 8px 0;"><tr><td bgcolor="${bg}" style="background:${bg};border:1px solid ${border};border-radius:6px;mso-padding-alt:10px 18px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;font-weight:600;line-height:20px;color:${C.brandBg};text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`;
}

const e = escapeHtml;

function sectionTitle(title: string): string {
  return `<div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};padding-bottom:6px;">${e(title)}</div>`;
}

/** One attack class as a two-line table row: the numbers, then times and paths
 *  full width (reads on a 390 px phone and a desktop client alike). */
function classRowHtml(c: ClassLine): string {
  const td = `border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:19px;color:${C.ink};`;
  const times = c.firstAt === c.lastAt ? `At ${formatWhen(c.firstAt)}` : `First ${formatWhen(c.firstAt)}<br>Last ${formatWhen(c.lastAt)}`;
  return `<tr><td valign="top" style="${td}padding:9px 8px 2px 0;font-weight:600;">${e(cap1(attackLabel(c.attackClass)))}</td><td valign="top" align="right" style="${td}padding:9px 8px 2px;white-space:nowrap;">${e(c.count.toLocaleString("en-US"))}</td><td valign="top" align="right" style="${td}padding:9px 8px 2px;white-space:nowrap;">${e(sourcesText(c.sources))}</td><td valign="top" style="${td}padding:9px 0 2px 8px;">${e(outcomeText(c.outcomes))}</td></tr>`
    + `<tr><td colspan="4" style="padding:0 0 9px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};word-break:break-word;">${times.split("<br>").map(e).join("<br>")}<br><span style="font-family:${MONO};font-size:11px;">${e(pathsText(c))}</span></td></tr>`;
}

function classTableHtml(lines: ClassLine[]): string {
  const th = `padding:0 8px 6px 0;font-family:${FONT};font-size:12px;font-weight:600;color:${C.muted};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="${th}">Attack type</td><td align="right" style="${th}padding-left:8px;">Attempts</td><td align="right" style="${th}padding-left:8px;">Sources</td><td style="${th}padding-left:8px;">Outcome</td></tr>${lines.map(classRowHtml).join("")}</table>`;
}

function sourcesText(n: number): string {
  return n > 0 ? n.toLocaleString("en-US") : "not recorded";
}

export function outcomeText(o: { blocked: number; contained: number; recorded: number }): string {
  const parts: string[] = [];
  if (o.blocked) parts.push(`${o.blocked.toLocaleString("en-US")} blocked`);
  if (o.contained) parts.push(`${o.contained.toLocaleString("en-US")} contained`);
  if (o.recorded) parts.push(`${o.recorded.toLocaleString("en-US")} not blocked`);
  return parts.length ? parts.join(", ") : "no outcome recorded";
}

function pathsText(c: Pick<ClassLine, "paths" | "pathCount">): string {
  return `${c.pathCount === 1 ? "Path" : "Top paths"}: ${listWithMore(c.paths, c.pathCount)}`;
}

function classLinesText(lines: ClassLine[]): string[] {
  const t: string[] = [];
  for (const c of lines) {
    t.push(`- ${cap1(attackLabel(c.attackClass))}: ${plural(c.count, "attempt")}, sources ${sourcesText(c.sources)}, ${outcomeText(c.outcomes)}`);
    t.push(c.firstAt === c.lastAt ? `  At ${formatWhen(c.firstAt)}` : `  First ${formatWhen(c.firstAt)}; last ${formatWhen(c.lastAt)}`);
    t.push(`  ${pathsText(c)}`);
  }
  return t;
}

interface ShellParts {
  audience: AlertAudience;
  subject: string;
  severity: Severity;
  headline: string;
  status: StatusBlock;
  primary: Link;
  secondary: Link[];
  /** Pre-escaped HTML sections between the buttons and the footer. */
  sectionsHtml: string;
  footerWhy: string;
  footerList: string;
  footerChange: string;
  footerIds: string;
}

/** The one enterprise frame every Forcefield email uses (alert and digest). */
function renderShell(p: ShellParts): string {
  const tone = TONE[p.status.tone];
  const sevc = SEV[p.severity];
  const links = [p.primary, ...p.secondary];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(p.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(`${p.headline}. ${p.status.status}. ${p.status.action}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#eef1f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:640px;background:#ffffff;border:1px solid ${C.line};border-radius:8px;">
<tr><td bgcolor="${C.brandBg}" style="background:${C.brandBg};padding:16px 28px;border-radius:8px 8px 0 0;"><span style="font-family:${FONT};font-size:15px;font-weight:800;letter-spacing:0.12em;color:#ffffff;">OGIAM</span><span style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.gold};padding-left:10px;">Forcefield</span><span style="font-family:${FONT};font-size:12px;color:#c9cdd4;padding-left:10px;">${p.severity === "Info" ? "Daily security digest" : p.audience === "operator" ? "Security alert" : "Site protection alert"}</span></td></tr>
<tr><td style="padding:24px 28px 0;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${sevc.bg};color:${sevc.ink};font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${p.severity === "Info" ? "Digest" : `${e(p.severity)} severity`}</span>
<h1 style="margin:12px 0 0;font-family:${FONT};font-size:22px;line-height:29px;font-weight:700;color:${C.ink};">${e(p.headline)}</h1></td></tr>
<tr><td style="padding:18px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:14px 16px;background:${tone.bg};border:1px solid ${tone.border};border-left:4px solid ${tone.border};border-radius:6px;font-family:${FONT};"><div style="font-size:15px;font-weight:700;line-height:21px;color:${tone.ink};">${e(p.status.status)}</div><div style="margin-top:4px;font-size:14px;line-height:20px;color:${tone.ink};">${e(p.status.action)}</div></td></tr></table></td></tr>
<tr><td style="padding:20px 28px 4px;">${button(p.primary.label, p.primary.href, true)}${p.secondary.map((l) => button(l.label, l.href, false)).join("")}</td></tr>
${p.sectionsHtml}
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${e(p.footerWhy)} ${e(p.footerList)}<br>${e(p.footerChange)}${p.footerIds ? `<br><span style="font-family:${MONO};font-size:11px;">${e(p.footerIds)}</span>` : ""}<br>Links: ${links.map((l) => `<a href="${e(l.href)}" style="color:${C.link};">${e(l.label)}</a>`).join(" · ")}</td></tr>
</table>
<div style="font-family:${FONT};font-size:11px;line-height:16px;color:${C.muted};padding-top:12px;">OGIAM Forcefield${p.audience === "operator" ? " · operated from Wolfpack Instinct" : ""}</div>
</td></tr></table>
</body></html>`;
}

function footers(audience: AlertAudience, recipients: string[], siteLabel: string | undefined) {
  return {
    footerWhy: audience === "operator"
      ? "You receive this because you are on the Forcefield security alert list for Wolfpack Instinct."
      : `You receive this because alerts are turned on for ${displaySite(siteLabel) || "your site"} in Forcefield.`,
    footerList: recipients.length ? `Sent to: ${recipients.join(", ")}.` : "",
    footerChange: audience === "operator"
      ? "To change who receives these, update FORCEFIELD_ALERT_RECIPIENT_EMAIL (comma-separated) in the Wolfpack Instinct Vercel project."
      : "To change who receives these, contact your OGIAM representative.",
  };
}

function footerText(f: { footerWhy: string; footerList: string; footerChange: string }, ids: string): string[] {
  const t = ["--", `${f.footerWhy} ${f.footerList}`.trim(), f.footerChange];
  if (ids) t.push(ids);
  return t;
}

export function renderForcefieldAlertEmail(alert: ForcefieldAlert, opts: RenderOptions): RenderedAlertEmail {
  if (alert.kind === "alert_digest" && alert.digest) return renderDigest(alert, alert.digest, opts);
  const audience = opts.audience;
  const subject = alertSubject(alert);
  const headline = alertHeadline(alert);
  const sev = alertSeverity(alert);
  const st = statusBlock(alert, audience);
  const rows = detailRows(alert, audience, opts.tenantName);
  const sig = signalExplanation(alert);
  const decision = audience === "operator" ? blockDecisionText(alert.incident?.blockDecision, alert.incident?.clientTypes[0]) : null;
  const { primary, secondary } = linksFor(alert, opts);
  const links = [primary, ...secondary];
  const recipients = opts.recipients.filter(Boolean);
  const f = footers(audience, recipients, alert.site);
  const footerIds = audience === "operator" ? `Alert id: ${opts.alertId ?? "n/a"} · Dedupe key: ${alert.dedupeKey}` : "";
  // The class table appears when the burst spans more than one attack class; a
  // single class is already named by the subject and headline.
  const classes = alert.kind === "hostile_incident" && (alert.classes?.length ?? 0) > 1 ? alert.classes ?? [] : [];
  const benefits = benefitLines(alert);

  /* ---------- HTML ---------- */
  const rowHtml = rows.map((r) => `<tr><td valign="top" style="padding:9px 12px 9px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:19px;color:${C.muted};width:132px;white-space:nowrap;">${e(r.label)}</td><td valign="top" style="padding:9px 0;border-top:1px solid ${C.line};font-family:${r.mono ? MONO : FONT};font-size:${r.mono ? 12 : 14}px;line-height:19px;color:${C.ink};word-break:break-word;">${e(r.value)}</td></tr>`).join("");
  const explainHtml = sig ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};"><strong style="color:${C.ink};">What this alert means.</strong> ${e(sig.explain)}</p>` : "";
  const decisionHtml = decision ? `<tr><td style="padding:0 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:14px 16px;background:${C.soft};border:1px solid ${C.line};border-radius:6px;font-family:${FONT};"><div style="font-size:13px;font-weight:700;line-height:19px;color:${C.ink};">${e(decision.title)}</div><div style="margin-top:4px;font-size:13px;line-height:20px;color:${C.muted};">${e(decision.text)}</div></td></tr></table></td></tr>` : "";
  const classesHtml = classes.length > 0 ? `<tr><td style="padding:8px 28px 8px;">${sectionTitle(classes.length === 1 ? "Attack type in this incident" : `${classes.length} attack types in this incident`)}${classTableHtml(classes)}</td></tr>` : "";
  const benefitHtml = benefits.length > 0
    ? `<tr><td style="padding:8px 28px 8px;">${sectionTitle("What Forcefield did for you")}<ul style="margin:0;padding:0 0 0 18px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.ink};">${benefits.map((b) => `<li style="margin:0 0 6px;">${e(b)}</li>`).join("")}</ul></td></tr>`
    : "";
  const sectionsHtml = `${benefitHtml}
${classesHtml}
<tr><td style="padding:8px 28px 8px;">${sectionTitle("Technical details (for your security contact)")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rowHtml}</table>${explainHtml}</td></tr>
${decisionHtml}`;
  const html = renderShell({ audience, subject, severity: sev, headline, status: st, primary, secondary, sectionsHtml, ...f, footerIds });

  /* ---------- plain text (same facts, same links) ---------- */
  const t: string[] = [];
  t.push(`${sev.toUpperCase()} SEVERITY`);
  t.push(headline);
  t.push("");
  t.push(st.status);
  t.push(st.action);
  t.push("");
  t.push(`${primary.label}: ${primary.href}`);
  if (benefits.length > 0) {
    t.push("");
    t.push("WHAT FORCEFIELD DID FOR YOU");
    for (const b of benefits) t.push(`- ${b}`);
  }
  if (classes.length > 0) {
    t.push("");
    t.push(classes.length === 1 ? "ATTACK TYPE IN THIS INCIDENT" : `${classes.length} ATTACK TYPES IN THIS INCIDENT`);
    t.push(...classLinesText(classes));
  }
  t.push("");
  t.push("TECHNICAL DETAILS (FOR YOUR SECURITY CONTACT)");
  for (const r of rows) t.push(`${r.label}: ${r.value}`);
  if (sig) { t.push(""); t.push(`What this alert means: ${sig.explain}`); }
  if (decision) { t.push(""); t.push(`${decision.title}: ${decision.text}`); }
  t.push("");
  t.push("LINKS");
  for (const l of links) t.push(`${l.label}: ${l.href}`);
  t.push("");
  t.push(...footerText(f, footerIds));

  return { subject, html, text: t.join("\n"), links };
}

/** A short plain summary for the in-app notification body and the alert row. */
export function alertSummary(alert: ForcefieldAlert): string {
  const st = statusBlock(alert, "operator");
  return `${alertHeadline(alert)}. ${st.status}. ${st.action}`;
}

/* --------------------------------- digest ---------------------------------- */

function etDay(etDate: string): string {
  const [y, m, d] = etDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function digestSubject(d: DigestData): string {
  const t = d.totals;
  return `[Forcefield] Daily digest ${etDay(d.etDate)}: ${plural(t.incidents, "blocked incident")} on ${plural(t.sites, "site")} (${plural(t.attempts, "attempt")})`;
}

function digestHeadline(d: DigestData): string {
  const t = d.totals;
  return `Forcefield stopped ${plural(t.attempts, "attack attempt")} on ${plural(t.sites, "site")} before they reached them (${plural(t.incidents, "incident")})`;
}

function digestStatus(d: DigestData): StatusBlock {
  const o = d.sites.reduce((a, s) => ({ blocked: a.blocked + s.outcomes.blocked, contained: a.contained + s.outcomes.contained, recorded: a.recorded + s.outcomes.recorded }), { blocked: 0, contained: 0, recorded: 0 });
  const status = o.contained > 0 ? `Stopped: ${outcomeText(o)}` : `Blocked at the edge (${plural(o.blocked, "request")})`;
  const immediate = d.immediateIncidents > 0
    ? ` ${plural(d.immediateIncidents, "other incident")} in this period needed attention and ${d.immediateIncidents === 1 ? "was" : "were"} emailed when ${d.immediateIncidents === 1 ? "it" : "they"} happened.`
    : "";
  return { tone: "good", status, action: `No action needed. Every request below was stopped before it reached the site.${immediate}` };
}

function periodText(d: DigestData): string {
  return `${formatWhen(d.periodStart)} to ${formatWhen(d.periodEnd)}`;
}

function renderDigest(alert: ForcefieldAlert, d: DigestData, opts: RenderOptions): RenderedAlertEmail {
  // Operator only: the digest names internal board links for every site.
  const audience: AlertAudience = "operator";
  const base = opts.baseUrl.replace(/\/$/, "");
  const subject = digestSubject(d);
  const headline = digestHeadline(d);
  const st = digestStatus(d);
  const { primary, secondary } = linksFor(alert, { ...opts, audience });
  const siteLinks: Link[] = d.sites.map((s) => ({ label: `Open ${displaySite(s.site)} on the board`, href: `${base}${boardHref({ tab: "forcefield", view: "operator", days: 7, site: s.site })}` }));
  const recipients = opts.recipients.filter(Boolean);
  const f = footers(audience, recipients, undefined);
  const footerIds = `Digest id: ${opts.alertId ?? "n/a"} · Dedupe key: ${alert.dedupeKey}`;
  const t = d.totals;

  const totalsRows: Row[] = [
    { label: "Period", value: periodText(d) },
    { label: "Sites", value: d.sites.map((s) => displaySite(s.site)).join(", ") },
    { label: "Incidents", value: t.incidents.toLocaleString("en-US") },
    { label: "Attempts", value: t.attempts.toLocaleString("en-US") },
    { label: "Sources", value: t.sources > 0 ? `${t.sources.toLocaleString("en-US")} distinct fingerprints` : "Fingerprint not recorded" },
    { label: "Sent immediately", value: d.immediateIncidents > 0 ? `${plural(d.immediateIncidents, "incident")} (decoy trips or requests not blocked), emailed when they happened` : "None in this period" },
  ];
  const rowHtml = (rows: Row[]) => rows.map((r) => `<tr><td valign="top" style="padding:9px 12px 9px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:19px;color:${C.muted};width:132px;white-space:nowrap;">${e(r.label)}</td><td valign="top" style="padding:9px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:19px;color:${C.ink};word-break:break-word;">${e(r.value)}</td></tr>`).join("");
  const siteSummary = (s: DigestData["sites"][number]) =>
    `${plural(s.incidents, "incident")} · ${plural(s.attempts, "attempt")} · ${s.sources > 0 ? plural(s.sources, "source") : "sources not recorded"} · ${outcomeText(s.outcomes)}`;
  const siteHtml = d.sites.map((s, n) => `<tr><td style="padding:16px 28px 8px;">${sectionTitle(displaySite(s.site))}<div style="font-family:${FONT};font-size:13px;line-height:19px;color:${C.muted};padding-bottom:10px;">${e(siteSummary(s))}</div>${classTableHtml(s.rows)}<div style="padding-top:6px;font-family:${FONT};font-size:13px;line-height:19px;"><a href="${e(siteLinks[n].href)}" style="color:${C.link};">${e(siteLinks[n].label)}</a></div></td></tr>`).join("\n");
  const sectionsHtml = `<tr><td style="padding:8px 28px 8px;">${sectionTitle("Summary")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rowHtml(totalsRows)}</table></td></tr>
${siteHtml}
<tr><td style="padding:8px 28px 16px;"><p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};"><strong style="color:${C.ink};">What this digest is.</strong> Payload attacks that were blocked or contained at the edge do not page anyone. They are collected here once a day, one row per attack type per site. Decoy and honeytoken trips, and any request that was recorded but not stopped, are still emailed as they happen. Times are exact; sources are distinct client fingerprints.</p></td></tr>`;
  const allLinks = [primary, ...siteLinks, ...secondary];
  const html = renderShell({ audience, subject, severity: "Info", headline, status: st, primary, secondary, sectionsHtml, ...f, footerIds });

  const txt: string[] = [];
  txt.push("DAILY DIGEST");
  txt.push(headline);
  txt.push("");
  txt.push(st.status);
  txt.push(st.action);
  txt.push("");
  txt.push(`${primary.label}: ${primary.href}`);
  txt.push("");
  txt.push("SUMMARY");
  for (const r of totalsRows) txt.push(`${r.label}: ${r.value}`);
  for (const [n, s] of d.sites.entries()) {
    txt.push("");
    txt.push(displaySite(s.site).toUpperCase());
    txt.push(siteSummary(s));
    txt.push(...classLinesText(s.rows));
    txt.push(`${siteLinks[n].label}: ${siteLinks[n].href}`);
  }
  txt.push("");
  txt.push("LINKS");
  for (const l of allLinks) txt.push(`${l.label}: ${l.href}`);
  txt.push("");
  txt.push(...footerText(f, footerIds));
  return { subject, html, text: txt.join("\n"), links: allLinks };
}
