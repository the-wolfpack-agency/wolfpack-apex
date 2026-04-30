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
/* Scan write                                                          */
/* ------------------------------------------------------------------ */

export async function recordScan(args: {
  codeId: string;
  blocked?: boolean;
  headers: Headers;
  geo?: { country?: string; region?: string; city?: string };
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

    await writeQuery(
      `INSERT INTO instinct_qr_scans
         (code_id, visitor_hash, country, region, city,
          device, os, browser, referrer, blocked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
      ],
    );
  } catch (err) {
    console.warn("[qr/scans] recordScan failed:", (err as Error).message);
  }
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
