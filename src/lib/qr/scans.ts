/**
 * QR scan recording + analytics.
 *
 * `recordScan` is called by the public /q/[slug] redirect handler,
 * once per scan, BEFORE the 302 is returned. It is fire-and-forget
 * by design: a failed analytics write must NEVER block a user's
 * redirect. All errors are swallowed and logged.
 *
 * Visitor fingerprint is a SHA256(IP + UA) sliced to 16 hex chars.
 * That's enough to deduplicate "unique visitors" within a window
 * without storing raw IPs (privacy-respecting by default).
 *
 * UA classification is intentionally tiny — a few well-known device /
 * OS / browser regexes. We don't pull in the ~50KB ua-parser-js dep
 * for what is essentially a coarse mobile/desktop/bot bucket.
 *
 * `getAnalytics` returns one rollup payload covering the dashboard's
 * panels. Each panel is a single SQL aggregate; Postgres handles
 * the small row counts in <10ms.
 *
 * Migration 112 (Apr 30, 2026) added extended attribution columns:
 *   language, timezone_offset_minutes, screen_size, is_bot,
 *   utm_source/medium/campaign, latitude, longitude, postal_code,
 *   client_id, client_match_score. `recordScan` populates all of
 *   them best-effort; everything is nullable so a deploy on the
 *   pre-112 schema still inserts cleanly via column-name targeting.
 */

import { createHash } from "crypto";
import { safeQuery, writeQuery } from "@/lib/db";

/* ------------------------------------------------------------------ */
/* User-agent parser                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedUa {
  device: "mobile" | "tablet" | "desktop" | "bot" | "unknown";
  os: string;
  browser: string;
}

const BOT_RE = /bot|crawler|spider|crawling|scrape/i;
const TABLET_RE = /iPad|Android(?!.*Mobile)|Tablet/i;
const MOBILE_RE = /iPhone|iPod|Android.*Mobile|Mobile|Phone/i;

/* Broader bot detector for the new is_bot column. Adds `preview` so
   link-unfurl fetchers (Slack, iMessage, Discord, Twitter card) are
   flagged even when their UA otherwise looks like a real browser. */
const IS_BOT_RE = /bot|crawler|spider|preview/i;

export function parseUserAgent(ua: string | null | undefined): ParsedUa {
  if (!ua) {
    return { device: "unknown", os: "unknown", browser: "unknown" };
  }

  /* Device class. Bot check FIRST so e.g. Googlebot (which carries
     Mobile in some variants) doesn't get bucketed as mobile. */
  let device: ParsedUa["device"] = "desktop";
  if (BOT_RE.test(ua)) device = "bot";
  else if (TABLET_RE.test(ua)) device = "tablet";
  else if (MOBILE_RE.test(ua)) device = "mobile";

  /* OS detection. Order matters — iOS before Mac (iPad ships with
     Mac OS substring on iPadOS 13+). */
  let os = "unknown";
  if (/iPhone|iPod|iPad|iOS/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS|Macintosh/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";

  /* Browser detection. Order matters — Edge before Chrome (Edge UA
     contains "Chrome"), and Safari last (Chrome/Edge contain "Safari"). */
  let browser = "unknown";
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  return { device, os, browser };
}

export function isBotUa(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return IS_BOT_RE.test(ua);
}

/* ------------------------------------------------------------------ */
/* Visitor hash                                                        */
/* ------------------------------------------------------------------ */

/**
 * Hash IP + UA into a 16-char hex string. SHA256 truncated. Lets us
 * count unique visitors per code without storing raw IPs.
 */
export function visitorHash(ip: string, ua: string): string {
  return createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 16);
}

function extractIp(headers: Headers): string {
  /* Vercel/Next sets x-forwarded-for; first entry is the real client. */
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/* ------------------------------------------------------------------ */
/* Header / URL extraction helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * First language tag from an Accept-Language header (e.g. "en-US,fr;q=0.9"
 * → "en-US"). Returns null when the header is absent or malformed.
 */
export function extractLanguage(headers: Headers): string | null {
  const raw = headers.get("accept-language");
  if (!raw) return null;
  const first = raw.split(",")[0]?.split(";")[0]?.trim();
  if (!first) return null;
  /* Cap to 35 chars (BCP-47 max realiztic length) and reject control chars. */
  if (first.length > 35) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(first)) return null;
  return first;
}

/**
 * Parse UTM parameters off an arbitrary URL. Returns an object with
 * each value coerced to string|null.
 */
export function extractUtm(rawUrl: string | undefined | null): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
} {
  if (!rawUrl) return { source: null, medium: null, campaign: null };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { source: null, medium: null, campaign: null };
  }
  const sp = parsed.searchParams;
  const cap = (v: string | null): string | null =>
    v && v.length > 0 && v.length <= 200 ? v : null;
  return {
    source: cap(sp.get("utm_source")),
    medium: cap(sp.get("utm_medium")),
    campaign: cap(sp.get("utm_campaign")),
  };
}

/**
 * Parse `?tz=...&s=WxH` off the request URL. tz is parsed as int
 * minutes; rejected when out of range (-720..840). screen_size is
 * accepted as `WxH` digits only.
 */
export function extractClientHints(rawUrl: string | undefined | null): {
  tzOffsetMinutes: number | null;
  screenSize: string | null;
} {
  if (!rawUrl) return { tzOffsetMinutes: null, screenSize: null };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { tzOffsetMinutes: null, screenSize: null };
  }
  const sp = parsed.searchParams;

  let tz: number | null = null;
  const tzRaw = sp.get("tz");
  if (tzRaw !== null) {
    const n = parseInt(tzRaw, 10);
    if (Number.isInteger(n) && n >= -720 && n <= 840) tz = n;
  }

  let s: string | null = null;
  const sRaw = sp.get("s");
  if (sRaw !== null && /^\d{2,5}x\d{2,5}$/.test(sRaw)) {
    s = sRaw;
  }

  return { tzOffsetMinutes: tz, screenSize: s };
}

/**
 * Lat/lng/postal off Vercel's edge headers. Returns null for any value
 * the headers didn't supply; latitude+longitude are coupled (we never
 * store one without the other to avoid bogus "exactly on the meridian"
 * dots in the UI).
 */
export function extractEdgeGeo(headers: Headers): {
  latitude: string | null;
  longitude: string | null;
  postalCode: string | null;
} {
  const lat = headers.get("x-vercel-ip-latitude");
  const lon = headers.get("x-vercel-ip-longitude");
  const postal = headers.get("x-vercel-ip-postal-code");
  /* Both lat/lng must be present and parse as finite numbers. */
  let latitude: string | null = null;
  let longitude: string | null = null;
  if (lat && lon) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (
      Number.isFinite(latN) &&
      Number.isFinite(lonN) &&
      latN >= -90 &&
      latN <= 90 &&
      lonN >= -180 &&
      lonN <= 180
    ) {
      latitude = lat;
      longitude = lon;
    }
  }
  return {
    latitude,
    longitude,
    postalCode: postal && postal.length <= 16 ? postal : null,
  };
}

/* ------------------------------------------------------------------ */
/* Client match heuristic                                              */
/* ------------------------------------------------------------------ */

interface ClientRowMinimal {
  id: string;
  name: string;
  contact_email: string | null;
}

interface ClientMatch {
  clientId: string | null;
  score: number;
}

/**
 * Score every row in instinct_clients against a scan's signals and
 * return the highest-scoring match (>= 0.5) or null.
 *
 * The instinct_clients table inherits from apex_clients (renamed in
 * migration 058) and only carries `name`, `industry`, `contact_email`,
 * `contact_name`, `notes`, `docs (jsonb)`. There is NO city/state/website
 * column today, so the heuristic is intentionally narrow:
 *
 *   - Referrer host matches the domain of the client's contact_email
 *     (e.g. referrer=example.com → contact_email=ops@example.com): +0.5
 *   - City exact-match (case-insensitive) against `docs.address_city` if
 *     present in jsonb: +0.5
 *   - Region/state match against `docs.address_state`: +0.2
 *
 * If the table doesn't exist or the query fails (read-only safeQuery),
 * returns { clientId: null, score: 0 } silently — a missing client
 * lookup must NEVER block a scan from being recorded.
 */
export async function matchClient(args: {
  city?: string | null;
  region?: string | null;
  referrer?: string | null;
}): Promise<ClientMatch> {
  const referrerHost = parseHost(args.referrer);
  if (!referrerHost && !args.city && !args.region) {
    return { clientId: null, score: 0 };
  }

  const result = await safeQuery<
    ClientRowMinimal & {
      docs: Record<string, unknown> | unknown[] | null;
    }
  >(
    `SELECT id::text AS id, name, contact_email, docs
       FROM instinct_clients
      LIMIT 500`,
    [],
  );

  if (!result.rows.length) {
    return { clientId: null, score: 0 };
  }

  let best: ClientMatch = { clientId: null, score: 0 };
  for (const row of result.rows) {
    const score = scoreClient(row, {
      city: args.city ?? null,
      region: args.region ?? null,
      referrerHost,
    });
    if (score > best.score) {
      best = { clientId: row.id, score };
    }
  }

  /* Threshold per task spec — drop weak matches so we don't render
     misleading "matched" badges in the UI. */
  if (best.score < 0.5) return { clientId: null, score: 0 };
  return best;
}

function parseHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().replace(/^www\./, "") || null;
}

function readJsonbString(
  blob: Record<string, unknown> | unknown[] | null,
  key: string,
): string | null {
  if (!blob || Array.isArray(blob)) return null;
  const v = (blob as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function scoreClient(
  row: ClientRowMinimal & {
    docs: Record<string, unknown> | unknown[] | null;
  },
  signals: {
    city: string | null;
    region: string | null;
    referrerHost: string | null;
  },
): number {
  let score = 0;

  /* Referrer ↔ contact-email domain. */
  const dom = emailDomain(row.contact_email);
  if (signals.referrerHost && dom && signals.referrerHost === dom) {
    score += 0.5;
  } else if (
    signals.referrerHost &&
    dom &&
    (signals.referrerHost.endsWith(`.${dom}`) ||
      dom.endsWith(`.${signals.referrerHost}`))
  ) {
    /* Suffix match (subdomains). Half weight. */
    score += 0.25;
  }

  /* City / state from docs jsonb if the column carries them. */
  const docCity = readJsonbString(row.docs, "address_city");
  const docState = readJsonbString(row.docs, "address_state");
  if (signals.city && docCity && signals.city.toLowerCase() === docCity.toLowerCase()) {
    score += 0.5;
  }
  if (signals.region && docState && signals.region.toLowerCase() === docState.toLowerCase()) {
    score += 0.2;
  }

  return Math.min(1, Number(score.toFixed(2)));
}

/* ------------------------------------------------------------------ */
/* Scan write                                                          */
/* ------------------------------------------------------------------ */

export async function recordScan(args: {
  codeId: string;
  blocked?: boolean;
  headers: Headers;
  geo?: { country?: string; region?: string; city?: string };
  /** Full request URL — used to parse incoming UTMs + tz/s hints. */
  requestUrl?: string | null;
}): Promise<void> {
  /* Best-effort: never throw. A failed write here would block the
     302 redirect, which is unacceptable. */
  if (!args.codeId) return;
  if (!process.env.DATABASE_URL) return;

  try {
    const ua = args.headers.get("user-agent") ?? "";
    const referrer = args.headers.get("referer") ?? args.headers.get("referrer") ?? null;
    const ip = extractIp(args.headers);
    const fingerprint = visitorHash(ip, ua);
    const parsed = parseUserAgent(ua);

    const language = extractLanguage(args.headers);
    const utm = extractUtm(args.requestUrl ?? null);
    const hints = extractClientHints(args.requestUrl ?? null);
    const edge = extractEdgeGeo(args.headers);
    const isBot = isBotUa(ua);

    /* Light client-match heuristic. Wrapped so a slow / failing
       lookup never blocks the scan write. */
    let clientMatch: ClientMatch = { clientId: null, score: 0 };
    try {
      clientMatch = await matchClient({
        city: args.geo?.city ?? null,
        region: args.geo?.region ?? null,
        referrer,
      });
    } catch {
      /* Ignore — match is purely additive. */
    }

    await writeQuery(
      `INSERT INTO instinct_qr_scans
         (code_id, visitor_hash, country, region, city,
          device, os, browser, referrer, blocked,
          language, timezone_offset_minutes, screen_size, is_bot,
          utm_source, utm_medium, utm_campaign,
          latitude, longitude, postal_code,
          client_id, client_match_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14,
               $15, $16, $17,
               $18, $19, $20,
               $21, $22)`,
      [
        args.codeId,
        fingerprint,
        args.geo?.country ?? null,
        args.geo?.region ?? null,
        args.geo?.city ?? null,
        parsed.device,
        parsed.os,
        parsed.browser,
        referrer,
        args.blocked ?? false,
        language,
        hints.tzOffsetMinutes,
        hints.screenSize,
        isBot,
        utm.source,
        utm.medium,
        utm.campaign,
        edge.latitude,
        edge.longitude,
        edge.postalCode,
        clientMatch.clientId,
        clientMatch.clientId ? clientMatch.score : null,
      ],
    );
  } catch (err) {
    console.warn("[qr/scans] recordScan failed:", (err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* Per-scan list (powers the "View all scans" modal in the dashboard)   */
/* ------------------------------------------------------------------ */

export interface ScanRow {
  id: string;
  scanned_at: string;
  visitor_hash: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  language: string | null;
  timezone_offset_minutes: number | null;
  screen_size: string | null;
  is_bot: boolean;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  blocked: boolean;
  client_id: string | null;
  client_match_score: number | null;
  client_name: string | null;
}

/**
 * Last N scans for a code, fully denormalized including the matched
 * client's name (LEFT JOIN so unmatched scans still come through).
 *
 * Capped to 500 rows. The route layer additionally requires auth.
 */
export async function listScans(
  codeId: string,
  limit = 500,
): Promise<ScanRow[]> {
  if (!codeId) return [];
  const cap = Math.max(1, Math.min(limit, 500));

  /* The instinct_clients lookup is a LEFT JOIN to instinct_clients(id).
     Casting both sides to TEXT lets us tolerate the apex_clients legacy
     column type (TEXT) without committing to a UUID FK. */
  const result = await safeQuery<{
    id: string;
    scanned_at: string;
    visitor_hash: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    postal_code: string | null;
    latitude: string | null;
    longitude: string | null;
    device: string | null;
    os: string | null;
    browser: string | null;
    language: string | null;
    timezone_offset_minutes: number | null;
    screen_size: string | null;
    is_bot: boolean;
    referrer: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    blocked: boolean;
    client_id: string | null;
    client_match_score: string | number | null;
    client_name: string | null;
  }>(
    `SELECT s.id::text AS id,
            s.scanned_at,
            s.visitor_hash,
            s.country,
            s.region,
            s.city,
            s.postal_code,
            s.latitude,
            s.longitude,
            s.device,
            s.os,
            s.browser,
            s.language,
            s.timezone_offset_minutes,
            s.screen_size,
            s.is_bot,
            s.referrer,
            s.utm_source,
            s.utm_medium,
            s.utm_campaign,
            s.blocked,
            s.client_id,
            s.client_match_score,
            c.name AS client_name
       FROM instinct_qr_scans s
       LEFT JOIN instinct_clients c
              ON c.id::text = s.client_id
      WHERE s.code_id = $1
      ORDER BY s.scanned_at DESC
      LIMIT $2`,
    [codeId, cap],
  );

  return result.rows.map((r) => ({
    id: r.id,
    scanned_at: r.scanned_at,
    visitor_hash: r.visitor_hash,
    country: r.country,
    region: r.region,
    city: r.city,
    postal_code: r.postal_code,
    latitude: r.latitude,
    longitude: r.longitude,
    device: r.device,
    os: r.os,
    browser: r.browser,
    language: r.language,
    timezone_offset_minutes:
      r.timezone_offset_minutes === null ? null : Number(r.timezone_offset_minutes),
    screen_size: r.screen_size,
    is_bot: Boolean(r.is_bot),
    referrer: r.referrer,
    utm_source: r.utm_source,
    utm_medium: r.utm_medium,
    utm_campaign: r.utm_campaign,
    blocked: Boolean(r.blocked),
    client_id: r.client_id,
    client_match_score:
      r.client_match_score === null
        ? null
        : Number(r.client_match_score),
    client_name: r.client_name,
  }));
}

/* ------------------------------------------------------------------ */
/* Analytics rollup                                                    */
/* ------------------------------------------------------------------ */

export interface QrAnalytics {
  total_scans: number;
  unique_visitors: number;
  blocked_scans: number;
  last_scanned_at: string | null;
  by_day: Array<{ day: string; count: number }>;
  by_country: Array<{ country: string; count: number }>;
  by_device: Array<{ device: string; count: number }>;
  by_browser: Array<{ browser: string; count: number }>;
  by_os: Array<{ os: string; count: number }>;
  by_hour: Array<{ hour: number; count: number }>;
  top_referrers: Array<{ referrer: string; count: number }>;
  recent: Array<{
    scanned_at: string;
    country: string | null;
    device: string | null;
    browser: string | null;
    referrer: string | null;
  }>;
}

function emptyAnalytics(): QrAnalytics {
  return {
    total_scans: 0,
    unique_visitors: 0,
    blocked_scans: 0,
    last_scanned_at: null,
    by_day: [],
    by_country: [],
    by_device: [],
    by_browser: [],
    by_os: [],
    by_hour: [],
    top_referrers: [],
    recent: [],
  };
}

export async function getAnalytics(codeId: string): Promise<QrAnalytics> {
  if (!codeId) return emptyAnalytics();

  /* Headline counts. */
  const totals = await safeQuery<{
    total_scans: string | number;
    unique_visitors: string | number;
    blocked_scans: string | number;
    last_scanned_at: string | null;
  }>(
    `SELECT
        COUNT(*)::int                                    AS total_scans,
        COUNT(DISTINCT visitor_hash)::int                AS unique_visitors,
        COUNT(*) FILTER (WHERE blocked = TRUE)::int      AS blocked_scans,
        MAX(scanned_at)                                  AS last_scanned_at
       FROM instinct_qr_scans
      WHERE code_id = $1`,
    [codeId],
  );
  const headline = totals.rows[0] ?? {
    total_scans: 0,
    unique_visitors: 0,
    blocked_scans: 0,
    last_scanned_at: null,
  };

  /* Last 30 days. date_trunc keeps days aligned to UTC midnight; the
     UI converts to the viewer's TZ for display. */
  const byDay = await safeQuery<{ day: string; count: string | number }>(
    `SELECT to_char(date_trunc('day', scanned_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
        AND scanned_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1 ASC`,
    [codeId],
  );

  const byCountry = await safeQuery<{ country: string | null; count: string | number }>(
    `SELECT country, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
      GROUP BY country
      ORDER BY count DESC
      LIMIT 10`,
    [codeId],
  );

  const byDevice = await safeQuery<{ device: string | null; count: string | number }>(
    `SELECT device, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
      GROUP BY device
      ORDER BY count DESC`,
    [codeId],
  );

  const byBrowser = await safeQuery<{ browser: string | null; count: string | number }>(
    `SELECT browser, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
      GROUP BY browser
      ORDER BY count DESC`,
    [codeId],
  );

  const byOs = await safeQuery<{ os: string | null; count: string | number }>(
    `SELECT os, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
      GROUP BY os
      ORDER BY count DESC`,
    [codeId],
  );

  const byHour = await safeQuery<{ hour: string | number; count: string | number }>(
    `SELECT EXTRACT(HOUR FROM scanned_at)::int AS hour, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1
      GROUP BY 1
      ORDER BY 1 ASC`,
    [codeId],
  );

  const topReferrers = await safeQuery<{ referrer: string | null; count: string | number }>(
    `SELECT referrer, COUNT(*)::int AS count
       FROM instinct_qr_scans
      WHERE code_id = $1 AND referrer IS NOT NULL AND referrer <> ''
      GROUP BY referrer
      ORDER BY count DESC
      LIMIT 10`,
    [codeId],
  );

  const recent = await safeQuery<{
    scanned_at: string;
    country: string | null;
    device: string | null;
    browser: string | null;
    referrer: string | null;
  }>(
    `SELECT scanned_at, country, device, browser, referrer
       FROM instinct_qr_scans
      WHERE code_id = $1
      ORDER BY scanned_at DESC
      LIMIT 20`,
    [codeId],
  );

  const toNumber = (v: string | number | null | undefined): number =>
    typeof v === "number" ? v : Number(v ?? 0);

  return {
    total_scans: toNumber(headline.total_scans),
    unique_visitors: toNumber(headline.unique_visitors),
    blocked_scans: toNumber(headline.blocked_scans),
    last_scanned_at: headline.last_scanned_at ?? null,
    by_day: byDay.rows.map((r) => ({ day: r.day, count: toNumber(r.count) })),
    by_country: byCountry.rows
      .filter((r) => r.country !== null && r.country !== "")
      .map((r) => ({ country: r.country as string, count: toNumber(r.count) })),
    by_device: byDevice.rows
      .filter((r) => r.device !== null)
      .map((r) => ({ device: r.device as string, count: toNumber(r.count) })),
    by_browser: byBrowser.rows
      .filter((r) => r.browser !== null)
      .map((r) => ({ browser: r.browser as string, count: toNumber(r.count) })),
    by_os: byOs.rows
      .filter((r) => r.os !== null)
      .map((r) => ({ os: r.os as string, count: toNumber(r.count) })),
    by_hour: byHour.rows.map((r) => ({ hour: toNumber(r.hour), count: toNumber(r.count) })),
    top_referrers: topReferrers.rows
      .filter((r) => r.referrer !== null)
      .map((r) => ({ referrer: r.referrer as string, count: toNumber(r.count) })),
    recent: recent.rows.map((r) => ({
      scanned_at: r.scanned_at,
      country: r.country,
      device: r.device,
      browser: r.browser,
      referrer: r.referrer,
    })),
  };
}
