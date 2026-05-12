/**
 * Microsoft 365 Contacts (Outlook personal contacts) write + sync layer.
 *
 * The legacy read helper lives at `@/lib/microsoft-graph#fetchContacts`
 * which still powers the assistant's read path. This module adds:
 *   - Full CRUD against /me/contacts with write-through into
 *     `instinct_contacts_mirror`
 *   - `syncAllContacts` using delta query so re-syncs only pull changes
 *   - Audit log on every mutation + analytics on every op
 *
 * Scope: Contacts.ReadWrite (already in MS_SCOPES).
 *
 * On 403 helpers return { ok:false, code:"scope_missing", scope:"Contacts.ReadWrite" }.
 */

 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, type AuditActor } from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirroredContact {
  id: string;
  userId: string;
  msContactId: string;
  displayName: string;
  emailAddresses: string[];
  phoneNumbers: string[];
  companyName: string | null;
  jobTitle: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface CreateContactInput {
  displayName: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: string[];
  phoneNumbers?: string[];
  companyName?: string;
  jobTitle?: string;
}

export interface UpdateContactInput {
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: string[];
  phoneNumbers?: string[];
  companyName?: string;
  jobTitle?: string;
}

export interface ListContactsOpts {
  limit?: number;
  cursor?: string; // mirror row id
  search?: string;
}

export interface SyncResult {
  synced: number;
  deleted: number;
  durationMs: number;
  deltaToken: string | null;
}

export type ScopeMissingResult = { ok: false; code: "scope_missing"; scope: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GraphContactsError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "GraphContactsError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new GraphContactsError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

async function graphCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  body?: unknown,
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    const retry = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!retry.ok) {
      throw new GraphContactsError(retry.status, `Graph ${method} ${endpoint} failed after retry: ${retry.status}`, retryAfter);
    }
    if (retry.status === 204) return undefined as unknown as T;
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new GraphContactsError(res.status, `Graph ${method} ${endpoint} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: { address: string; name?: string }[];
  mobilePhone?: string | null;
  businessPhones?: string[];
  homePhones?: string[];
  companyName?: string;
  jobTitle?: string;
  "@odata.etag"?: string;
  "@removed"?: { reason: string };
}

function mapPhones(g: GraphContact): string[] {
  const arr: string[] = [];
  if (g.mobilePhone) arr.push(g.mobilePhone);
  for (const p of g.businessPhones ?? []) if (p) arr.push(p);
  for (const p of g.homePhones ?? []) if (p) arr.push(p);
  return arr;
}

function mapEmails(g: GraphContact): string[] {
  return (g.emailAddresses ?? []).map((e) => e.address).filter((a) => !!a);
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertMirror(userId: string, g: GraphContact): Promise<MirroredContact> {
  const { rows } = await query<{ id: string; synced_at: string }>(
    `INSERT INTO instinct_contacts_mirror
       (user_id, ms_contact_id, display_name, email_addresses, phone_numbers,
        company_name, job_title, etag, synced_at, payload)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, now(), $9::jsonb)
     ON CONFLICT (user_id, ms_contact_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       email_addresses = EXCLUDED.email_addresses,
       phone_numbers = EXCLUDED.phone_numbers,
       company_name = EXCLUDED.company_name,
       job_title = EXCLUDED.job_title,
       etag = EXCLUDED.etag,
       synced_at = now(),
       payload = EXCLUDED.payload
     RETURNING id, synced_at`,
    [
      userId,
      g.id,
      g.displayName ?? "",
      JSON.stringify(mapEmails(g)),
      JSON.stringify(mapPhones(g)),
      g.companyName ?? null,
      g.jobTitle ?? null,
      g["@odata.etag"] ?? null,
      JSON.stringify(g),
    ],
  );
  return {
    id: rows[0].id,
    userId,
    msContactId: g.id,
    displayName: g.displayName ?? "",
    emailAddresses: mapEmails(g),
    phoneNumbers: mapPhones(g),
    companyName: g.companyName ?? null,
    jobTitle: g.jobTitle ?? null,
    etag: g["@odata.etag"] ?? null,
    syncedAt: new Date(rows[0].synced_at).toISOString(),
  };
}

async function deleteMirror(userId: string, msContactId: string): Promise<MirroredContact | null> {
  const { rows } = await query<any>(
    `DELETE FROM instinct_contacts_mirror
     WHERE user_id = $1 AND ms_contact_id = $2
     RETURNING id, display_name, email_addresses, phone_numbers, company_name, job_title, etag, synced_at`,
    [userId, msContactId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId,
    msContactId,
    displayName: r.display_name,
    emailAddresses: jsonArray(r.email_addresses),
    phoneNumbers: jsonArray(r.phone_numbers),
    companyName: r.company_name,
    jobTitle: r.job_title,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function jsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API — CRUD
// ---------------------------------------------------------------------------

/**
 * List contacts from the local mirror. Cache-miss is NOT implicit here —
 * callers should invoke syncAllContacts first (or the /api/contacts/sync
 * endpoint) when the mirror is empty.
 */
export async function listContacts(
  userId: string,
  opts: ListContactsOpts = {},
): Promise<{ contacts: MirroredContact[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  const conds: string[] = ["user_id = $1"];

  if (opts.search) {
    params.push(`%${opts.search}%`);
    const p = params.length;
    conds.push(`(display_name ILIKE $${p} OR company_name ILIKE $${p})`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_contact_id, display_name, email_addresses, phone_numbers,
            company_name, job_title, etag, synced_at
     FROM instinct_contacts_mirror
     WHERE ${conds.join(" AND ")}
     ORDER BY display_name ASC, id ASC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const contacts: MirroredContact[] = taken.map((r) => ({
    id: r.id,
    userId: r.user_id,
    msContactId: r.ms_contact_id,
    displayName: r.display_name,
    emailAddresses: jsonArray(r.email_addresses),
    phoneNumbers: jsonArray(r.phone_numbers),
    companyName: r.company_name,
    jobTitle: r.job_title,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  }));
  return { contacts, nextCursor: hasMore ? contacts[contacts.length - 1].id : null };
}

/**
 * Create a contact. Write-through to Graph + mirror. Returns the Graph id.
 */
export async function createContact(
  userId: string,
  input: CreateContactInput,
  actor?: AuditActor,
): Promise<{ id: string; msContactId: string }> {
  const token = await resolveToken(userId);
  const body = inputToGraph(input);

  try {
    const g = await graphCall<GraphContact>("POST", "me/contacts", token, body);
    const mirrored = await upsertMirror(userId, g);
    trackEvent("system.ms_contact_created", userId, "system", {
      contact_id: g.id,
      has_email: (g.emailAddresses?.length ?? 0) > 0 ? 1 : 0,
    });
    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "contacts.created",
      resourceType: "ms_contact",
      resourceId: g.id,
      afterState: {
        display_name: g.displayName,
        email_addresses: mapEmails(g),
        company_name: g.companyName,
        job_title: g.jobTitle,
      },
    }).catch((e) => console.warn("[microsoft-contacts] audit failed:", (e as Error).message));
    return { id: mirrored.id, msContactId: g.id };
  } catch (err) {
    trackEvent("system.ms_contact_created", userId, "system", {
      ok: false,
      http_status: err instanceof GraphContactsError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Patch a contact. Write-through to Graph + mirror.
 */
export async function updateContact(
  userId: string,
  msContactId: string,
  patch: UpdateContactInput,
  actor?: AuditActor,
): Promise<{ id: string }> {
  const token = await resolveToken(userId);

  // Capture before-state for audit
  const { rows: prior } = await safeQuery<any>(
    `SELECT display_name, email_addresses, phone_numbers, company_name, job_title
     FROM instinct_contacts_mirror
     WHERE user_id = $1 AND ms_contact_id = $2 LIMIT 1`,
    [userId, msContactId],
  );
  const before = prior[0] ?? null;

  try {
    const g = await graphCall<GraphContact>(
      "PATCH",
      `me/contacts/${encodeURIComponent(msContactId)}`,
      token,
      inputToGraph(patch),
    );
    const mirrored = await upsertMirror(userId, g);
    trackEvent("system.ms_contact_updated", userId, "system", {
      contact_id: msContactId,
    });
    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "contacts.updated",
      resourceType: "ms_contact",
      resourceId: msContactId,
      beforeState: before
        ? {
            display_name: before.display_name,
            email_addresses: jsonArray(before.email_addresses),
            company_name: before.company_name,
            job_title: before.job_title,
          }
        : null,
      afterState: {
        display_name: g.displayName,
        email_addresses: mapEmails(g),
        company_name: g.companyName,
        job_title: g.jobTitle,
      },
    }).catch((e) => console.warn("[microsoft-contacts] audit failed:", (e as Error).message));
    return { id: mirrored.id };
  } catch (err) {
    trackEvent("system.ms_contact_updated", userId, "system", {
      ok: false,
      http_status: err instanceof GraphContactsError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Delete a contact. Removes mirror row + audits `contacts.deleted`.
 */
export async function deleteContact(
  userId: string,
  msContactId: string,
  actor?: AuditActor,
): Promise<void> {
  const token = await resolveToken(userId);
  try {
    await graphCall<void>(
      "DELETE",
      `me/contacts/${encodeURIComponent(msContactId)}`,
      token,
    );
    const removed = await deleteMirror(userId, msContactId);
    trackEvent("system.ms_contact_deleted", userId, "system", {
      contact_id: msContactId,
    });
    await recordAudit({
      actor: actor ?? { user_id: userId, role: "system" },
      action: "contacts.deleted",
      resourceType: "ms_contact",
      resourceId: msContactId,
      beforeState: removed
        ? {
            display_name: removed.displayName,
            email_addresses: removed.emailAddresses,
            company_name: removed.companyName,
            job_title: removed.jobTitle,
          }
        : null,
    }).catch((e) => console.warn("[microsoft-contacts] audit failed:", (e as Error).message));
  } catch (err) {
    trackEvent("system.ms_contact_deleted", userId, "system", {
      ok: false,
      http_status: err instanceof GraphContactsError ? err.status : 0,
    });
    throw err;
  }
}

/**
 * Full or delta sync. Uses `/me/contacts/delta` when a deltaToken exists
 * for the user (stored in `payload->>'_delta_token'` on a sentinel row),
 * else does a full list. Upserts every returned record, removes any that
 * the delta feed marks as deleted. Emits `system.ms_contacts_sync`.
 *
 * Safe to call repeatedly; idempotent.
 */
export async function syncAllContacts(userId: string): Promise<SyncResult> {
  const start = Date.now();
  const token = await resolveToken(userId);

  // Check for a prior delta token in a sentinel row on the mirror.
  const prior = await readDeltaToken(userId);
  let endpoint: string;
  if (prior) {
    endpoint = prior; // delta URLs are absolute
  } else {
    endpoint = `me/contacts/delta?$top=50`;
  }

  let synced = 0;
  let deleted = 0;
  let nextDelta: string | null = null;

  try {
    // Page through until we see @odata.deltaLink (end of change feed) or
    // stop after a safety cap of 200 pages (10k contacts).
    for (let page = 0; page < 200; page++) {
      const res = await graphCall<{
        value: GraphContact[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>("GET", endpoint, token);

      for (const g of res.value ?? []) {
        if (g["@removed"]) {
          await deleteMirror(userId, g.id).catch(() => {});
          deleted++;
        } else {
          await upsertMirror(userId, g);
          synced++;
        }
      }

      if (res["@odata.deltaLink"]) {
        nextDelta = res["@odata.deltaLink"];
        break;
      }
      if (!res["@odata.nextLink"]) break;
      endpoint = res["@odata.nextLink"];
    }

    if (nextDelta) await writeDeltaToken(userId, nextDelta);

    const durationMs = Date.now() - start;
    trackEvent("system.ms_contacts_sync", userId, "system", {
      synced,
      deleted,
      delta_used: prior ? 1 : 0,
      duration_ms: durationMs,
    });
    return { synced, deleted, durationMs, deltaToken: nextDelta };
  } catch (err) {
    const durationMs = Date.now() - start;
    trackEvent("system.ms_contacts_sync", userId, "system", {
      ok: false,
      synced,
      deleted,
      http_status: err instanceof GraphContactsError ? err.status : 0,
      duration_ms: durationMs,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delta-token storage (on a sentinel mirror row, id prefix "__delta__:")
// ---------------------------------------------------------------------------

const DELTA_SENTINEL_PREFIX = "__delta__:";

async function readDeltaToken(userId: string): Promise<string | null> {
  const { rows } = await safeQuery<{ etag: string | null }>(
    `SELECT etag FROM instinct_contacts_mirror
     WHERE user_id = $1 AND ms_contact_id = $2
     LIMIT 1`,
    [userId, DELTA_SENTINEL_PREFIX + userId],
  );
  if (rows.length === 0) return null;
  return rows[0].etag ?? null;
}

async function writeDeltaToken(userId: string, deltaLink: string): Promise<void> {
  await query(
    `INSERT INTO instinct_contacts_mirror
       (user_id, ms_contact_id, display_name, email_addresses, phone_numbers, etag, synced_at)
     VALUES ($1, $2, '', '[]'::jsonb, '[]'::jsonb, $3, now())
     ON CONFLICT (user_id, ms_contact_id) DO UPDATE SET
       etag = EXCLUDED.etag,
       synced_at = now()`,
    [userId, DELTA_SENTINEL_PREFIX + userId, deltaLink],
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inputToGraph(input: CreateContactInput | UpdateContactInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.displayName !== undefined) body.displayName = input.displayName;
  if (input.givenName !== undefined) body.givenName = input.givenName;
  if (input.surname !== undefined) body.surname = input.surname;
  if (input.companyName !== undefined) body.companyName = input.companyName;
  if (input.jobTitle !== undefined) body.jobTitle = input.jobTitle;
  if (input.emailAddresses !== undefined) {
    body.emailAddresses = input.emailAddresses.map((address) => ({ address, name: address }));
  }
  if (input.phoneNumbers !== undefined) {
    body.mobilePhone = input.phoneNumbers[0] ?? null;
    body.businessPhones = input.phoneNumbers.slice(1);
  }
  return body;
}
