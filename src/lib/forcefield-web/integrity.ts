/**
 * Forcefield for the Web - page integrity, the SITE side (vendored, edge-safe).
 *
 * Every visitor's browser can tell us when a page loads something the site never
 * loads: an injected card skimmer, a hijacked third-party script, a form posting
 * to a stranger. Server-side tools never see that; the browser does.
 *
 *   1. The site sends integrityPolicy() as Content-Security-Policy-Report-Only.
 *      Report-only: the browser enforces NOTHING, so the page cannot break.
 *   2. The browser posts a report to the site's own INTEGRITY_REPORT_PATH.
 *   3. The site's route calls handleIntegrityReport, which keeps only the
 *      directive, the blocked ORIGIN (never a full URL, path or query) and the
 *      page path, drops browser-extension and inline noise, and forwards the
 *      result to Instinct with the ingest token the site already holds.
 *
 * Instinct counts distinct sessions and pages per origin: an injected script
 * shows up for every visitor, an extension for one person. Never throws; the
 * browser always gets 204.
 */
import { clientKeys } from "./observe";
import { DEFAULT_RULESET } from "./ruleset";

/** Where a site's pages ask the browser to send reports (same origin). */
export const INTEGRITY_REPORT_PATH = "/api/forcefield/integrity-report";

/** The directives watched: where a skimmer loads code or sends what it took. */
export const INTEGRITY_DIRECTIVES = ["script-src", "frame-src", "connect-src", "form-action"] as const;
export type IntegrityDirective = (typeof INTEGRITY_DIRECTIVES)[number];

export interface IntegrityReport {
  directive: IntegrityDirective;
  /** scheme://host[:port], or "data" / "blob". */
  blockedOrigin: string;
  /** The page path the violation happened on. */
  page: string;
}

const ORIGIN_TOKEN = /^(https?:\/\/[a-z0-9.-]+(:\d{1,5})?|https:|data:|blob:|'self')$/i;

/**
 * The report-only policy. Everything the site itself serves ('self') and any
 * origin it names in `allow` is expected; anything else is reported. Inline and
 * eval are allowed in the policy (frameworks inline their own bootstraps, which
 * would otherwise report on every page view): this watches ORIGINS.
 */
export function integrityPolicy(opts: { allow?: Partial<Record<IntegrityDirective, readonly string[]>>; reportPath?: string } = {}): string {
  const extra = (d: IntegrityDirective) => (opts.allow?.[d] ?? []).filter((o) => ORIGIN_TOKEN.test(o));
  const parts = INTEGRITY_DIRECTIVES.map((d) => {
    const base = d === "script-src" ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'"];
    return [d, ...base, ...extra(d)].join(" ");
  });
  return [...parts, `report-uri ${opts.reportPath ?? INTEGRITY_REPORT_PATH}`].join("; ");
}

const NOISE_SCHEMES = /^(chrome|moz|safari|safari-web|ms-browser|edge)-extension:|^(about|chrome|webkit-masked-url|resource):/i;

function directiveOf(raw: unknown): IntegrityDirective | null {
  const d = String(raw ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (d === "script-src" || d === "script-src-elem" || d === "script-src-attr" || d === "worker-src") return "script-src";
  if (d === "frame-src" || d === "child-src") return "frame-src";
  if (d === "connect-src") return "connect-src";
  if (d === "form-action") return "form-action";
  return null;
}

function originOf(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v || NOISE_SCHEMES.test(v)) return null;
  const lc = v.toLowerCase();
  if (lc === "inline" || lc === "eval" || lc === "self" || lc === "wasm-eval" || lc === "trusted-types-policy" || lc === "trusted-types-sink") return null;
  if (lc === "data" || lc.startsWith("data:")) return "data";
  if (lc === "blob" || lc.startsWith("blob:")) return "blob";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function pageOf(raw: unknown): string {
  try {
    return new URL(String(raw ?? "")).pathname.slice(0, 200) || "/";
  } catch {
    return "/";
  }
}

const MAX_REPORTS = 20;

/**
 * Both browser report formats, normalized (pure): the classic report-uri body
 * ({"csp-report": {...}}) and the Reporting API batch ([{type: "csp-violation",
 * body: {...}}]). Anything unrecognized or noisy is dropped.
 */
export function normalizeIntegrityReports(body: unknown): IntegrityReport[] {
  const raw: Array<Record<string, unknown>> = [];
  if (Array.isArray(body)) {
    for (const r of body.slice(0, MAX_REPORTS)) {
      const o = r as { type?: unknown; body?: unknown };
      if (o && o.type === "csp-violation" && o.body && typeof o.body === "object") {
        const b = o.body as Record<string, unknown>;
        raw.push({ directive: b.effectiveDirective ?? b.violatedDirective, blocked: b.blockedURL, page: b.documentURL, disposition: b.disposition });
      }
    }
  } else if (body && typeof body === "object" && (body as Record<string, unknown>)["csp-report"]) {
    const b = (body as Record<string, unknown>)["csp-report"] as Record<string, unknown>;
    if (b && typeof b === "object") raw.push({ directive: b["effective-directive"] ?? b["violated-directive"], blocked: b["blocked-uri"], page: b["document-uri"], disposition: b.disposition });
  }
  const out: IntegrityReport[] = [];
  for (const r of raw) {
    const directive = directiveOf(r.directive);
    const blockedOrigin = originOf(r.blocked);
    if (!directive || !blockedOrigin) continue;
    out.push({ directive, blockedOrigin, page: pageOf(r.page) });
  }
  return out;
}

/** Instinct's integrity endpoint, derived from the ingest URL like the others. */
export function integrityEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (!env.FORCEFIELD_INGEST_URL) return null;
    return `${new URL(env.FORCEFIELD_INGEST_URL).origin}/api/forcefield/integrity`;
  } catch {
    return null;
  }
}

const DEDUPE_MS = 10 * 60_000;
const _recent = new Map<string, number>();
export function _resetIntegrityDedupe(): void { _recent.clear(); }

const MAX_BODY = 16_384;

/**
 * The site's report route, in one call: read (size-capped), normalize, drop what
 * this instance already forwarded for the same session, origin and page in the
 * last 10 minutes, and forward the rest. Always answers 204.
 */
export async function handleIntegrityReport(
  site: string,
  req: { headers: Headers; text(): Promise<string> },
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<Response> {
  const done = () => new Response(null, { status: 204 });
  try {
    const url = integrityEndpoint(env);
    const token = env.SITE_ANALYTICS_INGEST_TOKEN;
    if (!url || !token) return done();
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return done();
    const text = await req.text();
    if (text.length > MAX_BODY) return done();
    const reports = normalizeIntegrityReports(JSON.parse(text));
    if (reports.length === 0) return done();
    const h = req.headers;
    const { sig } = clientKeys(
      { userAgent: h.get("user-agent") ?? "", country: h.get("x-vercel-ip-country") ?? "", headerNames: Array.from(h.keys()), nowMs },
      DEFAULT_RULESET,
    );
    if (_recent.size > 5000) _recent.clear();
    const fresh = reports.filter((r) => {
      const k = `${sig}|${r.directive}|${r.blockedOrigin}|${r.page}`;
      const at = _recent.get(k);
      if (at !== undefined && nowMs - at < DEDUPE_MS) return false;
      _recent.set(k, nowMs);
      return true;
    });
    if (fresh.length === 0) return done();
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": token },
      body: JSON.stringify({ site, sig, reports: fresh }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
  } catch {
    /* a malformed body or an unreachable Instinct: nothing recorded */
  }
  return done();
}
