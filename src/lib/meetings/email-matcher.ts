/**
 * Robust attendee → email-thread matcher.
 *
 * The targeted "filter messages by attendee address" approach has been
 * fragile across tenants because:
 *   - Graph's attendee objects don't always expose `address` (so the
 *     event's attendeeEmails[] can be empty on live tenants even for
 *     busy internal meetings).
 *   - OR'd $filter expressions over /me/messages get rejected as
 *     InefficientFilter on many tenants (silent empty response).
 *   - Per-contact filters miss threads the user kicked off (FROM is
 *     the user, not the contact).
 *
 * This matcher sidesteps all three: fetch a recent bulk slice of the
 * mailbox (inbox + sent) with full recipient data, then filter in
 * memory by any attendee token — name OR email — appearing in any
 * participant string. Simple, boring, correct.
 */

import { getValidToken, graphFetch, type Email } from "@/lib/microsoft-graph";

interface RawRecipient {
  emailAddress: { name?: string; address?: string };
}
interface RawMessage {
  id: string;
  subject: string;
  from: { emailAddress: { name?: string; address?: string } } | null;
  toRecipients?: RawRecipient[];
  ccRecipients?: RawRecipient[];
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  importance: string;
  webLink?: string;
}

const SELECT = [
  "id",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "bodyPreview",
  "isRead",
  "importance",
  "webLink",
].join(",");

// Calendar auto-generated response emails ("Accepted: X meeting",
// "Declined: Y", "Tentative: Z") are noise for the prebrief — they
// flood recent threads without carrying conversation content.
const CALENDAR_RESPONSE_PREFIX = /^\s*(accepted|declined|tentative|canceled|cancelled):\s/i;
function isCalendarResponseNoise(subject: string | undefined | null): boolean {
  return !!subject && CALENDAR_RESPONSE_PREFIX.test(subject);
}

// Per-user bulk-fetch cache. The bulk pull (100 messages across
// inbox + sent) is the slow part of the prebrief — caching it for a
// couple minutes means the 2nd, 3rd, Nth meeting in the dropdown
// reuses the same fetch instead of re-pulling each time.
interface BulkCacheEntry {
  messages: RawMessage[];
  expiresAt: number;
}
const BULK_TTL_MS = 2 * 60 * 1000;
const bulkCache = new Map<string, BulkCacheEntry>();
function bulkCacheGet(key: string): RawMessage[] | null {
  const hit = bulkCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    bulkCache.delete(key);
    return null;
  }
  return hit.messages;
}
function bulkCacheSet(key: string, messages: RawMessage[]): void {
  bulkCache.set(key, { messages, expiresAt: Date.now() + BULK_TTL_MS });
}
/** Test-only: reset between specs. */
export function __resetBulkCache(): void {
  bulkCache.clear();
}

async function fetchFolderPage(
  userId: string,
  folder: "inbox" | "sentitems",
  count: number,
  token: string,
): Promise<RawMessage[]> {
  try {
    const data = await graphFetch<{ value?: RawMessage[] }>(
      `me/mailFolders/${folder}/messages?$top=${count}&$orderby=${encodeURIComponent(
        "receivedDateTime desc",
      )}&$select=${encodeURIComponent(SELECT)}`,
      token,
      userId,
    );
    return data?.value ?? [];
  } catch {
    return [];
  }
}

function collectNeedles(attendees: string[], attendeeEmails: string[]): string[] {
  const out = new Set<string>();
  for (const a of attendeeEmails) {
    const v = a.trim().toLowerCase();
    if (v) out.add(v);
  }
  for (const a of attendees) {
    if (typeof a !== "string") continue;
    const v = a.trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

function messageHaystack(msg: RawMessage): string {
  const bits: string[] = [];
  const fromAddr = msg.from?.emailAddress;
  if (fromAddr?.name) bits.push(fromAddr.name);
  if (fromAddr?.address) bits.push(fromAddr.address);
  for (const r of msg.toRecipients ?? []) {
    if (r.emailAddress?.name) bits.push(r.emailAddress.name);
    if (r.emailAddress?.address) bits.push(r.emailAddress.address);
  }
  for (const r of msg.ccRecipients ?? []) {
    if (r.emailAddress?.name) bits.push(r.emailAddress.name);
    if (r.emailAddress?.address) bits.push(r.emailAddress.address);
  }
  return bits.join(" ").toLowerCase();
}

export function matchMessagesToAttendees(
  messages: RawMessage[],
  attendees: string[],
  attendeeEmails: string[],
): RawMessage[] {
  const needles = collectNeedles(attendees, attendeeEmails);
  if (needles.length === 0) return [];
  const seen = new Set<string>();
  const hits: RawMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    // Drop calendar-response auto-emails — they match on subject
    // (organizer/attendee name) but add no real thread context.
    if (isCalendarResponseNoise(m.subject)) continue;
    const hay = messageHaystack(m);
    if (needles.some((n) => n && hay.includes(n))) {
      seen.add(m.id);
      hits.push(m);
    }
  }
  return hits;
}

function toEmail(msg: RawMessage): Email {
  const name = msg.from?.emailAddress?.name;
  const addr = msg.from?.emailAddress?.address ?? "";
  const importance = (msg.importance?.toLowerCase() || "normal") as
    | "low"
    | "normal"
    | "high";
  return {
    id: msg.id,
    subject: msg.subject,
    from: name || addr || "You",
    fromEmail: addr,
    receivedDateTime: msg.receivedDateTime,
    bodyPreview: msg.bodyPreview,
    isRead: msg.isRead,
    importance,
    // Optional — Email type doesn't require webLink, so we attach it
    // via cast so the UI can render <a href={webLink}>.
    ...(msg.webLink ? { webLink: msg.webLink } : {}),
  } as Email & { webLink?: string };
}

/**
 * Find recent threads that involve any of the given attendees by name
 * or email. Pulls `poolSize` messages each from Inbox + Sent Items
 * (defaults to 50 each = 100 total), filters client-side, returns up
 * to `limit` newest hits.
 */
export async function findThreadsInvolvingAttendees(
  userId: string,
  attendees: string[],
  attendeeEmails: string[],
  limit = 3,
  poolSize = 50,
): Promise<Email[]> {
  if (attendees.length === 0 && attendeeEmails.length === 0) return [];

  // Reuse the bulk pull across all meetings in a single prebrief
  // session — huge latency win on dashboards with multiple meetings.
  const cacheKey = `${userId}:${poolSize}`;
  let combined = bulkCacheGet(cacheKey);
  if (!combined) {
    const token = await getValidToken(userId).catch(() => null);
    if (!token) return [];
    const [inbox, sent] = await Promise.all([
      fetchFolderPage(userId, "inbox", poolSize, token.accessToken),
      fetchFolderPage(userId, "sentitems", poolSize, token.accessToken),
    ]);
    combined = [...inbox, ...sent];
    bulkCacheSet(cacheKey, combined);
  }

  const hits = matchMessagesToAttendees(combined, attendees, attendeeEmails);
  hits.sort((a, b) =>
    a.receivedDateTime < b.receivedDateTime
      ? 1
      : a.receivedDateTime > b.receivedDateTime
        ? -1
        : 0,
  );
  return hits.slice(0, limit).map(toEmail);
}

/* ----------------------------------------------------------------------
 * Strict sender/recipient mail search — sibling to the matcher above.
 *
 * findThreadsInvolvingAttendees treats sender + recipients identically,
 * which is right for the meeting-prebrief use case ("anyone on the
 * thread") but wrong for the chat's mail search ("emails FROM Max"
 * shouldn't surface threads where Max is just CC'd). This function
 * applies strict, side-specific substring matching against the FROM
 * address (when `fromNeedle` is set) or the TO/CC recipients (when
 * `toNeedle` is set).
 *
 * Reuses the same bulk-fetch cache as findThreadsInvolvingAttendees
 * so back-to-back searches stay fast.
 * -------------------------------------------------------------------- */

function fromHaystack(msg: RawMessage): string {
  const bits: string[] = [];
  const a = msg.from?.emailAddress;
  if (a?.name) bits.push(a.name);
  if (a?.address) bits.push(a.address);
  return bits.join(" ").toLowerCase();
}

function recipientHaystack(msg: RawMessage): string {
  const bits: string[] = [];
  for (const r of msg.toRecipients ?? []) {
    if (r.emailAddress?.name) bits.push(r.emailAddress.name);
    if (r.emailAddress?.address) bits.push(r.emailAddress.address);
  }
  for (const r of msg.ccRecipients ?? []) {
    if (r.emailAddress?.name) bits.push(r.emailAddress.name);
    if (r.emailAddress?.address) bits.push(r.emailAddress.address);
  }
  return bits.join(" ").toLowerCase();
}

export interface FindMailOptions {
  fromNeedle?: string;
  toNeedle?: string;
  limit?: number;
  poolSize?: number;
}

export async function findMailBySenderOrRecipient(
  userId: string,
  opts: FindMailOptions,
): Promise<Email[]> {
  const fromNeedle = opts.fromNeedle?.trim().toLowerCase();
  const toNeedle = opts.toNeedle?.trim().toLowerCase();
  if (!fromNeedle && !toNeedle) return [];
  const limit = opts.limit ?? 10;
  const poolSize = opts.poolSize ?? 50;

  const cacheKey = `${userId}:${poolSize}`;
  let combined = bulkCacheGet(cacheKey);
  if (!combined) {
    const token = await getValidToken(userId).catch(() => null);
    if (!token) return [];
    const [inbox, sent] = await Promise.all([
      fetchFolderPage(userId, "inbox", poolSize, token.accessToken),
      fetchFolderPage(userId, "sentitems", poolSize, token.accessToken),
    ]);
    combined = [...inbox, ...sent];
    bulkCacheSet(cacheKey, combined);
  }

  const seen = new Set<string>();
  const hits: RawMessage[] = [];
  for (const m of combined) {
    if (seen.has(m.id)) continue;
    if (isCalendarResponseNoise(m.subject)) continue;
    /* AND semantics: both needles must match when both are set
     * (e.g. "emails from Max to Hoxsie"). */
    if (fromNeedle && !fromHaystack(m).includes(fromNeedle)) continue;
    if (toNeedle && !recipientHaystack(m).includes(toNeedle)) continue;
    seen.add(m.id);
    hits.push(m);
  }
  hits.sort((a, b) =>
    a.receivedDateTime < b.receivedDateTime
      ? 1
      : a.receivedDateTime > b.receivedDateTime
        ? -1
        : 0,
  );
  return hits.slice(0, limit).map(toEmail);
}
