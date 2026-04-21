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
].join(",");

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
  };
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
  const token = await getValidToken(userId).catch(() => null);
  if (!token) return [];

  const [inbox, sent] = await Promise.all([
    fetchFolderPage(userId, "inbox", poolSize, token.accessToken),
    fetchFolderPage(userId, "sentitems", poolSize, token.accessToken),
  ]);

  const combined = [...inbox, ...sent];
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
