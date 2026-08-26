/**
 * Meeting Pre-Brief — source fan-out layer.
 *
 * Given a meeting event id + (workspaceId, userId), pull every signal
 * the synthesizer needs from every system we know about, in parallel,
 * with a degraded-source fallback for each. Returns a typed
 * MeetingSources blob + the versionMarkers needed to compute the cache
 * hash.
 *
 * Hard contract:
 *   - No source ever throws. Every fetch is Promise.allSettled-wrapped
 *     and a failure contributes "no data" instead of poisoning the
 *     synthesis. Each degraded source emits
 *     `system.meeting_prep_source_degraded` so we see which integrations
 *     are slow/broken without breaking the user.
 *   - Every read is workspace-scoped through the connector lookup
 *     (no leakage between tenants).
 *   - The source_hash is deterministic — same versionMarkers in,
 *     same hash out. Two users opening the same upcoming meeting at
 *     the same minute produce identical hashes and hit the cache.
 *
 * Source list (5+):
 *   1. Microsoft Graph calendar  — fetchCalendarEvents (the event itself
 *      + attendee list + body preview)
 *   2. Microsoft Graph mail      — fetchEmailsFromContact per attendee
 *      (last 5 messages each)
 *   3. CRM connector              — searchRecords("contact", email, 1)
 *      per attendee, then searchRelated("account", name, "opportunity")
 *      for that attendee's account
 *   4. Central Brain              — searchKnowledge(<attendee name>)
 *      per attendee (top 5 facts)
 *   5. Calendar (history)         — past-90-day scan of the same calendar
 *      window for prior meetings with any attendee
 */

import { createHash } from "node:crypto";
import {
  fetchCalendarEvents,
  fetchEmailsFromContact,
  type CalendarEvent,
  type Email,
} from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";
import { searchKnowledge } from "@/lib/knowledge";
import {
  pickConfiguredConnector,
  loadConnectorCredentials,
} from "@/lib/assistant/connectors/credentials";
import { buildRestConnectorForWorkspace } from "@/lib/assistant/connectors/rest-connector";

/* --------------------------- Types ------------------------------------ */

export interface MeetingSourcesEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  attendeeEmails: string[];
  body_preview: string;
}

export interface MeetingSourcesOpportunity {
  id: string;
  name: string;
  stage?: string;
  amount?: number;
  closeDate?: string;
}

export interface MeetingSourcesEmail {
  subject: string;
  snippet: string;
  received: string;
  direction: "in" | "out";
}

export interface MeetingSourcesAttendee {
  email: string;
  name?: string;
  crm: {
    contact?: Record<string, unknown> | null;
    account?: Record<string, unknown> | null;
    recentOpportunities: MeetingSourcesOpportunity[];
  } | null;
  recentEmails: MeetingSourcesEmail[];
  lastMeeting?: { date: string; subject: string };
  brainFacts: string[];
}

export interface MeetingSourcesVersionMarkers {
  crmLastModified: Record<string, string>;
  lastEmailReceivedAt: Record<string, string>;
  lastBrainEditAt: string;
}

/** A document worth reading before the meeting. */
export interface MeetingSourcesDocument {
  documentId: string;
  filename: string;
  /** Written once at ingest, so this is a description rather than a fragment. */
  summary: string;
  topics: string[];
  /** Opens the original, in SharePoint or wherever it came from. */
  webUrl: string | null;
}

export interface MeetingSources {
  event: MeetingSourcesEvent;
  perAttendee: MeetingSourcesAttendee[];
  /**
   * What to read before this meeting.
   *
   * The brain search that already existed here looks up each ATTENDEE by name,
   * which finds facts about people. Nobody was asking the library what the
   * MEETING is about, so the documents that exist on the subject, the ones a
   * person would want to have read, were never surfaced.
   *
   * This is the join a single system cannot do: the calendar knows there is a
   * dealer review on Thursday, the library knows which documents cover it, and
   * neither knows the other exists.
   */
  documents: MeetingSourcesDocument[];
  versionMarkers: MeetingSourcesVersionMarkers;
}

export interface FetchMeetingSourcesContext {
  workspaceId: string;
  userId: string;
  userRole?: string;
}

/* ------------------------- Helpers ------------------------------------ */

/** Pull a wide ±30-day calendar window so we catch the event regardless
 *  of TZ drift. The Graph cache dedupes; the wider window is cheap. */
function calendarWindow(): { start: string; end: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(now - 7 * day).toISOString(),
    end: new Date(now + 30 * day).toISOString(),
  };
}

function historyWindow(): { start: string; end: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(now - 90 * day).toISOString(),
    end: new Date(now).toISOString(),
  };
}

function nameFromAttendee(displayName: string, email: string): string | undefined {
  if (displayName && displayName.toLowerCase() !== email.toLowerCase()) {
    return displayName;
  }
  return undefined;
}

function emitDegraded(
  ctx: FetchMeetingSourcesContext,
  source: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  void trackEvent(
    "system.meeting_prep_source_degraded",
    ctx.userId,
    ctx.userRole ?? "unknown",
    { source, error: msg.slice(0, 280) },
  );
}

/** Best-effort: extract a usable CRM "last modified" string from a
 *  vendor-shaped record. Salesforce returns LastModifiedDate, HubSpot
 *  returns updatedAt, generic REST returns updated_at. Falls back to a
 *  stable empty string so missing data doesn't change the hash. */
function extractLastModified(record: Record<string, unknown> | null | undefined): string {
  if (!record) return "";
  for (const key of [
    "LastModifiedDate",
    "lastModifiedDate",
    "updatedAt",
    "updated_at",
    "modifiedAt",
    "modified_at",
  ]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function extractAccountName(
  record: Record<string, unknown> | null | undefined,
): string | null {
  if (!record) return null;
  for (const key of ["Account", "account", "Company", "company", "AccountName"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "Name" in (v as Record<string, unknown>)) {
      const inner = (v as Record<string, unknown>).Name;
      if (typeof inner === "string" && inner.length > 0) return inner;
    }
  }
  return null;
}

/* --------------------- Per-attendee fan-out --------------------------- */

interface ConnectorHandle {
  searchRecords: (
    objectType: string,
    query: string,
    limit?: number,
  ) => Promise<{
    ok: boolean;
    data?: Array<Record<string, unknown>>;
    code?: string;
    message?: string;
  }>;
  searchRelated?: (
    parentType: string,
    parentName: string,
    relatedType: string,
    limit?: number,
  ) => Promise<{
    ok: boolean;
    data?: Array<Record<string, unknown>>;
    code?: string;
    message?: string;
  }>;
}

async function resolveConnector(
  workspaceId: string,
): Promise<ConnectorHandle | null> {
  try {
    const connectorName = await pickConfiguredConnector(workspaceId);
    if (!connectorName) return null;
    const creds = await loadConnectorCredentials(workspaceId, connectorName);
    if (!creds) return null;
    return await buildRestConnectorForWorkspace(workspaceId, connectorName);
  } catch {
    return null;
  }
}

async function fetchAttendeeCrm(
  ctx: FetchMeetingSourcesContext,
  connector: ConnectorHandle | null,
  email: string,
): Promise<{
  crm: MeetingSourcesAttendee["crm"];
  lastModified: string;
}> {
  if (!connector) {
    return { crm: null, lastModified: "" };
  }
  try {
    const contactResult = await connector.searchRecords("contact", email, 1);
    const contact = contactResult.ok ? contactResult.data?.[0] ?? null : null;
    let account: Record<string, unknown> | null = null;
    let recentOpportunities: MeetingSourcesOpportunity[] = [];
    if (contact) {
      const accountName = extractAccountName(contact);
      if (accountName && connector.searchRelated) {
        try {
          const oppResult = await connector.searchRelated(
            "account",
            accountName,
            "opportunity",
            5,
          );
          if (oppResult.ok && oppResult.data) {
            recentOpportunities = oppResult.data.slice(0, 5).map((row, idx) => ({
              id: String(
                row.Id ?? row.id ?? `opp-${accountName}-${idx}`,
              ),
              name: String(row.Name ?? row.name ?? "Untitled"),
              stage:
                typeof row.StageName === "string"
                  ? row.StageName
                  : typeof row.stage === "string"
                    ? row.stage
                    : undefined,
              amount:
                typeof row.Amount === "number"
                  ? row.Amount
                  : typeof row.amount === "number"
                    ? row.amount
                    : undefined,
              closeDate:
                typeof row.CloseDate === "string"
                  ? row.CloseDate
                  : typeof row.closeDate === "string"
                    ? row.closeDate
                    : undefined,
            }));
            account = { name: accountName };
          }
        } catch (err) {
          emitDegraded(ctx, "crm_related_opportunities", err);
        }
      }
    }
    const lastModified = extractLastModified(contact);
    return {
      crm: contact || account || recentOpportunities.length > 0
        ? { contact: contact ?? undefined, account, recentOpportunities }
        : null,
      lastModified,
    };
  } catch (err) {
    emitDegraded(ctx, "crm_contact_search", err);
    return { crm: null, lastModified: "" };
  }
}

async function fetchAttendeeEmails(
  ctx: FetchMeetingSourcesContext,
  email: string,
): Promise<{ emails: MeetingSourcesEmail[]; lastReceived: string }> {
  try {
    const raw: Email[] = await fetchEmailsFromContact(ctx.userId, email, 5);
    const emails: MeetingSourcesEmail[] = raw.slice(0, 5).map((e) => ({
      subject: e.subject || "(no subject)",
      snippet: (e.bodyPreview || "").slice(0, 200),
      received: e.receivedDateTime,
      direction: (e.fromEmail || "").toLowerCase() === email.toLowerCase()
        ? "in"
        : "out",
    }));
    const lastReceived = emails.length > 0 ? emails[0].received : "";
    return { emails, lastReceived };
  } catch (err) {
    emitDegraded(ctx, "graph_mail", err);
    return { emails: [], lastReceived: "" };
  }
}

/**
 * Documents about what the meeting IS.
 *
 * Searched on the subject rather than on the attendees, because "what should I
 * have read before the dealer review" is a question about the review.
 *
 * GOES THROUGH queryBrain, which means it goes through the audience gate. A
 * meeting brief assembled from documents the reader may not open would be the
 * most efficient way imaginable to leak an HR file, since it arrives looking
 * like something the system decided they needed.
 *
 * Degrades to nothing. A brief without documents is still a brief; a brief
 * that fails to render because the library was unreachable is not.
 */
async function fetchMeetingDocuments(
  ctx: FetchMeetingSourcesContext,
  subject: string,
): Promise<MeetingSourcesDocument[]> {
  const topic = (subject || "").trim();
  if (!topic) return [];
  try {
    const { queryBrain } = await import("@/lib/brain/query");
    const res = await queryBrain({
      userId: ctx.userId,
      userRole: ctx.userRole ?? "",
      query: topic,
      limit: 6,
    });
    const seen = new Set<string>();
    const out: MeetingSourcesDocument[] = [];
    for (const hit of res.hits) {
      const id = String(hit.document_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        documentId: id,
        filename: String(hit.document_filename ?? "Untitled"),
        /* The summary written at ingest, not the chunk that matched. A chunk
           starting mid-sentence tells a reader nothing about whether the
           document is worth their time, which is the only question a
           pre-read list answers. */
        summary: String((hit as { document_summary?: string }).document_summary ?? "").trim(),
        topics: Array.isArray((hit as { document_topics?: string[] }).document_topics)
          ? ((hit as { document_topics?: string[] }).document_topics as string[])
          : [],
        webUrl: (hit as { web_url?: string }).web_url ?? null,
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch (err) {
    emitDegraded(ctx, "brain_search", err);
    return [];
  }
}

async function fetchAttendeeBrainFacts(
  ctx: FetchMeetingSourcesContext,
  name: string,
): Promise<string[]> {
  if (!name) return [];
  try {
    const results = await searchKnowledge(name, 5);
    return results
      .map((r) => (typeof r.answer === "string" ? r.answer.slice(0, 240) : ""))
      .filter((s) => s.length > 0)
      .slice(0, 5);
  } catch (err) {
    emitDegraded(ctx, "brain_search", err);
    return [];
  }
}

async function fetchLastMeetingWith(
  ctx: FetchMeetingSourcesContext,
  email: string,
  excludeId: string,
  historicalEvents: CalendarEvent[],
): Promise<{ date: string; subject: string } | undefined> {
  /* Reuse the wide-window fetch result (passed in) instead of issuing a
   * second graph call per attendee. Iterate descending by start. */
  const lower = email.toLowerCase();
  const sorted = [...historicalEvents]
    .filter((e) => e.id !== excludeId)
    .filter((e) => (e.attendeeEmails ?? []).some((a) => a.toLowerCase() === lower))
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  const match = sorted[0];
  if (!match) {
    void ctx; // marker
    return undefined;
  }
  return { date: match.start, subject: match.subject };
}

async function fetchLastBrainEditAt(): Promise<string> {
  /* Cheap timestamp: most-recent row in instinct_site_brief_edits. If the
   * table is unreachable, return an empty string so the hash is stable. */
  try {
    const { rows } = await safeQuery<{ created_at: string }>(
      `SELECT created_at::text AS created_at
         FROM instinct_site_brief_edits
        ORDER BY created_at DESC
        LIMIT 1`,
      [],
    );
    return rows[0]?.created_at ?? "";
  } catch {
    return "";
  }
}

/* ---------------------- Top-level fetch ------------------------------- */

export async function fetchMeetingSources(
  eventId: string,
  ctx: FetchMeetingSourcesContext,
): Promise<MeetingSources | null> {
  const { start, end } = calendarWindow();
  let calendarEvents: CalendarEvent[] = [];
  try {
    calendarEvents = await fetchCalendarEvents(ctx.userId, start, end);
  } catch (err) {
    emitDegraded(ctx, "graph_calendar", err);
  }
  const event = calendarEvents.find((e) => e.id === eventId);
  if (!event) return null;

  /* Build the attendee list. Graph hands back display names + emails
   * separately; we zip them by position when both arrays are equal length
   * (the common case), else fall back to email-only. */
  const emails = (event.attendeeEmails ?? []).filter((e) => e.includes("@"));
  const names = event.attendees ?? [];
  const attendeeMeta: Array<{ email: string; name?: string }> = emails.map(
    (email, idx) => ({
      email: email.toLowerCase(),
      name: nameFromAttendee(names[idx] ?? "", email),
    }),
  );

  /* History window for "last meeting with attendee" — separate fetch from
   * the present window so we don't artificially expand the cache key
   * surface. Falls back silently if Graph errors. */
  const { start: histStart, end: histEnd } = historyWindow();
  let historicalEvents: CalendarEvent[] = [];
  try {
    historicalEvents = await fetchCalendarEvents(
      ctx.userId,
      histStart,
      histEnd,
    );
  } catch (err) {
    emitDegraded(ctx, "graph_calendar_history", err);
  }

  /* Connector resolution happens once, not per attendee. */
  const connector = await resolveConnector(ctx.workspaceId);

  /* Fan out per-attendee fetches in parallel. Promise.allSettled
   * guarantees one slow integration doesn't block the others. */
  const settled = await Promise.allSettled(
    attendeeMeta.map(async (meta) => {
      const [crmResult, mailResult, brainFacts, lastMeeting] =
        await Promise.allSettled([
          fetchAttendeeCrm(ctx, connector, meta.email),
          fetchAttendeeEmails(ctx, meta.email),
          fetchAttendeeBrainFacts(ctx, meta.name ?? ""),
          fetchLastMeetingWith(ctx, meta.email, eventId, historicalEvents),
        ]);
      const crm = crmResult.status === "fulfilled" ? crmResult.value.crm : null;
      const crmLastModified =
        crmResult.status === "fulfilled" ? crmResult.value.lastModified : "";
      const emails =
        mailResult.status === "fulfilled" ? mailResult.value.emails : [];
      const lastReceived =
        mailResult.status === "fulfilled" ? mailResult.value.lastReceived : "";
      const brain = brainFacts.status === "fulfilled" ? brainFacts.value : [];
      const lm = lastMeeting.status === "fulfilled" ? lastMeeting.value : undefined;
      return {
        email: meta.email,
        name: meta.name,
        crm,
        recentEmails: emails,
        lastMeeting: lm,
        brainFacts: brain,
        _markers: { crmLastModified, lastReceived },
      };
    }),
  );

  const perAttendee: MeetingSourcesAttendee[] = [];
  const crmLastModified: Record<string, string> = {};
  const lastEmailReceivedAt: Record<string, string> = {};
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const v = s.value;
    perAttendee.push({
      email: v.email,
      name: v.name,
      crm: v.crm,
      recentEmails: v.recentEmails,
      lastMeeting: v.lastMeeting,
      brainFacts: v.brainFacts,
    });
    crmLastModified[v.email] = v._markers.crmLastModified;
    lastEmailReceivedAt[v.email] = v._markers.lastReceived;
  }

  const lastBrainEditAt = await fetchLastBrainEditAt();
  /* What to read before it. Searched on the subject, gated by who is asking. */
  const documents = await fetchMeetingDocuments(ctx, event.subject);

  return {
    documents,
    event: {
      id: event.id,
      subject: event.subject,
      start: event.start,
      end: event.end,
      attendees: event.attendees ?? [],
      attendeeEmails: emails,
      body_preview: "",
    },
    perAttendee,
    versionMarkers: {
      crmLastModified,
      lastEmailReceivedAt,
      lastBrainEditAt,
    },
  };
}

/* ------------------------ Hash computation ---------------------------- */

/**
 * Deterministic SHA-256 over the version markers. Same input → same
 * hash → same cache row. Sorts keys so JavaScript's non-deterministic
 * object property order can't change the hash for identical data.
 */
export function computeSourceHash(markers: MeetingSourcesVersionMarkers): string {
  const stable = {
    crmLastModified: sortKeys(markers.crmLastModified),
    lastEmailReceivedAt: sortKeys(markers.lastEmailReceivedAt),
    lastBrainEditAt: markers.lastBrainEditAt,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k] ?? "";
  }
  return out;
}


/** Test seam: the join is worth asserting on its own, and the function it
 *  lives in fans out to Graph, the CRM and the mailbox. */
export const fetchMeetingDocumentsForTests = fetchMeetingDocuments;
