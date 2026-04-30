/**
 * QR codes — CRUD helpers for `instinct_qr_codes`.
 *
 * Each code maps a short, human-friendly slug (~7 chars, base32-ish)
 * to a long target URL. The redirect endpoint at /q/[slug] looks up
 * the active code and 302s. Codes can carry an optional UTM campaign
 * (so paper/print impressions show up correctly in GA), an optional
 * expiry, and a soft-archive flag.
 *
 * Slug generation uses a 32-char alphabet with the visually ambiguous
 * chars (0/O, 1/I/L) removed so a printed code is easy to type. We
 * retry up to 5 times on collision before giving up — at 7 chars the
 * keyspace is ~34B, so a real collision is astronomically rare even
 * across the largest expected agency-scale corpus (millions of codes).
 *
 * URL validation rejects anything that isn't http/https. We intentionally
 * accept localhost / private hosts because internal demos use them.
 */

import { writeQuery, safeQuery } from "@/lib/db";

export interface QrCode {
  id: string;
  slug: string;
  targetUrl: string;
  label: string | null;
  utmCampaign: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  createdByUserId: string | null;
  createdByUserRole: string | null;
}

interface QrCodeRow {
  id: string;
  slug: string;
  target_url: string;
  label: string | null;
  utm_campaign: string | null;
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  created_by_user_role: string | null;
}

function rowToCode(row: QrCodeRow): QrCode {
  return {
    id: row.id,
    slug: row.slug,
    targetUrl: row.target_url,
    label: row.label,
    utmCampaign: row.utm_campaign,
    expiresAt: row.expires_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    createdByUserRole: row.created_by_user_role,
  };
}

/* ------------------------------------------------------------------ */
/* Slug generation                                                     */
/* ------------------------------------------------------------------ */

/* Crockford-style base32 minus the easy-to-confuse glyphs. 32 chars. */
const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SLUG_LENGTH = 7;

export function generateSlug(): string {
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * SLUG_ALPHABET.length);
    out += SLUG_ALPHABET[idx];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validate that a string is a real http/https URL. Returns the parsed
 * URL on success, throws on failure. We accept any host (incl. localhost)
 * because internal demos use them frequently.
 */
export function validateTargetUrl(raw: string): URL {
  if (!raw || typeof raw !== "string") {
    throw new Error("targetUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("targetUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("targetUrl must use http or https");
  }
  return parsed;
}

/**
 * Append UTM parameters to a target URL. Preserves any existing query
 * string and hash. If the URL already carries a `utm_campaign`, the
 * new campaign overrides only that one parameter — `utm_source` and
 * `utm_medium` are always set to `qr` / `offline` so a destination
 * site can identify offline QR scans even without the campaign.
 *
 * `appendUtm("https://x.test/page", "demo")`
 *   → "https://x.test/page?utm_source=qr&utm_medium=offline&utm_campaign=demo"
 *
 * `appendUtm("https://x.test/p?a=1#hash", "demo")`
 *   → "https://x.test/p?a=1&utm_source=qr&utm_medium=offline&utm_campaign=demo#hash"
 *
 * `appendUtm("https://x.test/p?utm_campaign=old&utm_source=email", "demo")`
 *   → preserves existing utm_source=email, ONLY overrides utm_campaign=demo
 */
export function appendUtm(targetUrl: string, campaign: string | null | undefined): string {
  if (!campaign) return targetUrl;
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return targetUrl;
  }
  /* Always override utm_campaign with the code's campaign. */
  parsed.searchParams.set("utm_campaign", campaign);
  /* Only set source/medium if they're not already present so existing
     campaigns (email, social) keep their original attribution. */
  if (!parsed.searchParams.has("utm_source")) {
    parsed.searchParams.set("utm_source", "qr");
  }
  if (!parsed.searchParams.has("utm_medium")) {
    parsed.searchParams.set("utm_medium", "offline");
  }
  return parsed.toString();
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

const SELECT_COLS =
  "id, slug, target_url, label, utm_campaign, expires_at, archived_at, " +
  "created_at, created_by_user_id, created_by_user_role";

export async function createCode(args: {
  targetUrl: string;
  label?: string | null;
  utmCampaign?: string | null;
  expiresAt?: string | null;
  userId: string;
  userRole: string;
}): Promise<QrCode> {
  /* URL validation throws on invalid input — let the route handler
     catch and surface a 400. */
  validateTargetUrl(args.targetUrl);

  /* Collision-retry loop. At 7 chars across 32 chars the keyspace is
     ~34 billion — a collision in any reasonable agency dataset is
     astronomically rare, but we still retry up to 5 times before
     giving up (and raising) so we never silently insert a duplicate. */
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = generateSlug();
    try {
      const result = await writeQuery<QrCodeRow>(
        `INSERT INTO instinct_qr_codes
          (slug, target_url, label, utm_campaign, expires_at,
           created_by_user_id, created_by_user_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SELECT_COLS}`,
        [
          slug,
          args.targetUrl,
          args.label ?? null,
          args.utmCampaign ?? null,
          args.expiresAt ?? null,
          args.userId,
          args.userRole,
        ],
        { expectRows: 1 },
      );
      return rowToCode(result.rows[0]);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      /* Postgres unique-violation surfaces with `23505`. We can't see
         the SQLSTATE through writeQuery's wrapper, so match on text. */
      if (!/duplicate|unique|23505/i.test(msg)) {
        throw err;
      }
      /* Otherwise, loop and try a fresh slug. */
    }
  }
  throw new Error(
    `[qr] Failed to generate unique slug after 5 attempts: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

export async function listCodes(opts?: {
  limit?: number;
  userId?: string;
  includeArchived?: boolean;
}): Promise<QrCode[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!opts?.includeArchived) {
    conditions.push("archived_at IS NULL");
  }
  if (opts?.userId) {
    params.push(opts.userId);
    conditions.push(`created_by_user_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const result = await safeQuery<QrCodeRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_qr_codes
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToCode);
}

export async function getCodeBySlug(slug: string): Promise<QrCode | null> {
  if (!slug) return null;
  const result = await safeQuery<QrCodeRow>(
    `SELECT ${SELECT_COLS} FROM instinct_qr_codes WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return result.rows[0] ? rowToCode(result.rows[0]) : null;
}

export async function getCodeById(id: string): Promise<QrCode | null> {
  if (!id) return null;
  const result = await safeQuery<QrCodeRow>(
    `SELECT ${SELECT_COLS} FROM instinct_qr_codes WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? rowToCode(result.rows[0]) : null;
}

export async function updateCode(
  id: string,
  patch: {
    targetUrl?: string;
    label?: string | null;
    utmCampaign?: string | null;
    expiresAt?: string | null;
  },
): Promise<QrCode> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.targetUrl !== undefined) {
    validateTargetUrl(patch.targetUrl);
    params.push(patch.targetUrl);
    sets.push(`target_url = $${params.length}`);
  }
  if (patch.label !== undefined) {
    params.push(patch.label);
    sets.push(`label = $${params.length}`);
  }
  if (patch.utmCampaign !== undefined) {
    params.push(patch.utmCampaign);
    sets.push(`utm_campaign = $${params.length}`);
  }
  if (patch.expiresAt !== undefined) {
    params.push(patch.expiresAt);
    sets.push(`expires_at = $${params.length}`);
  }

  if (sets.length === 0) {
    throw new Error("updateCode: patch is empty");
  }

  /* Always bump updated_at so audit dashboards can sort by recency. */
  sets.push(`updated_at = NOW()`);
  params.push(id);

  const result = await writeQuery<QrCodeRow>(
    `UPDATE instinct_qr_codes
        SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING ${SELECT_COLS}`,
    params,
    { expectRows: 1 },
  );
  return rowToCode(result.rows[0]);
}

export async function archiveCode(id: string): Promise<QrCode> {
  const result = await writeQuery<QrCodeRow>(
    `UPDATE instinct_qr_codes
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLS}`,
    [id],
    { expectRows: 1 },
  );
  return rowToCode(result.rows[0]);
}
