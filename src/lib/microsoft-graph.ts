/**
 * Microsoft Graph API Integration — OAuth2 + Calendar, Email, Contacts.
 *
 * Connects to Microsoft 365 via OAuth2 and fetches communication data:
 *   Calendar events, emails, contacts, unread count, user profile.
 *
 * Shadow mode: returns realistic demo data when MS_CLIENT_ID is not set.
 * All API calls are tracked via analytics and cached with 5-minute TTL.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { safeQuery, query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MsTokens {
  access_token: string;
  refresh_token: string;
  user_email: string;
  display_name?: string;
  expires_at: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  isOnlineMeeting: boolean;
}

export interface Email {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  importance: "low" | "normal" | "high";
}

export interface Contact {
  id: string;
  displayName: string;
  emailAddresses: string[];
  companyName: string;
  jobTitle: string;
  phone: string;
}

export interface UserProfile {
  displayName: string;
  email: string;
  jobTitle: string;
  photoUrl: string | null;
}

export interface MsConnectionStatus {
  connected: boolean;
  userEmail: string | null;
  displayName: string | null;
  lastSync: string | null;
  mode: "live" | "shadow";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MS_SCOPES = "Calendars.Read Mail.Read Contacts.Read User.Read offline_access";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Get the Azure AD tenant ID, defaulting to "common" for multi-tenant. */
function getTenantId(): string {
  return process.env.MS_TENANT_ID || "common";
}

function getAuthBaseUrl(): string {
  return `https://login.microsoftonline.com/${getTenantId()}/oauth2/v2.0`;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Clear cached Microsoft Graph data.
 * - clearCache()        — clears all entries (used by disconnect-all + tests)
 * - clearCache(userId)  — clears only the calling user's entries
 */
export function clearCache(userId?: string): void {
  if (!userId) {
    cache.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Shadow mode check
// ---------------------------------------------------------------------------

function isShadowMode(): boolean {
  return !process.env.MS_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// OAuth2 Helpers
// ---------------------------------------------------------------------------

/**
 * HMAC-sign a userId so it can safely round-trip through the OAuth state
 * parameter. Format: `${userId}.${sigBase64url}` — verified in the callback
 * to prevent attackers from associating their MS account with someone
 * else's apex user record by guessing IDs.
 */
function getStateSecret(): string {
  return process.env.INSTINCT_JWT_SECRET || process.env.APEX_JWT_SECRET || "instinct-dev-secret-do-not-use-in-production";
}

export function signState(userId: string): string {
  const sig = createHmac("sha256", getStateSecret())
    .update(userId)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${userId}.${sig}`;
}

export function verifyState(state: string | null): string | null {
  if (!state) return null;
  const dot = state.lastIndexOf(".");
  if (dot < 1) return null;
  const userId = state.slice(0, dot);
  const provided = state.slice(dot + 1);
  const expected = signState(userId).slice(userId.length + 1);
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? userId : null;
  } catch {
    return null;
  }
}

/**
 * Generate the Microsoft OAuth2 authorization URL for a specific user.
 * The userId is signed into the state parameter so the callback can
 * recover identity even when the session cookie is dropped on cross-site
 * redirect.
 */
export function getAuthUrl(userId: string): string {
  const clientId = process.env.MS_CLIENT_ID;
  const redirectUri = process.env.MS_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return "";
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: MS_SCOPES,
    response_mode: "query",
    state: signState(userId),
  });

  return `${getAuthBaseUrl()}/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(code: string): Promise<MsTokens | null> {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const redirectUri = process.env.MS_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) return null;

  try {
    const res = await fetch(`${getAuthBaseUrl()}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: MS_SCOPES,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[microsoft-graph] Token exchange failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_email: "",
      expires_at: expiresAt,
    };
  } catch (err) {
    console.error("[microsoft-graph] Token exchange error:", (err as Error).message);
    return null;
  }
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(currentRefreshToken: string): Promise<MsTokens | null> {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(`${getAuthBaseUrl()}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: currentRefreshToken,
        grant_type: "refresh_token",
        scope: MS_SCOPES,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[microsoft-graph] Token refresh failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_email: "",
      expires_at: expiresAt,
    };
  } catch (err) {
    console.error("[microsoft-graph] Token refresh error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token Storage
// ---------------------------------------------------------------------------

/**
 * Store Microsoft tokens in the database.
 */
export async function storeTokens(
  tokens: MsTokens,
  userId: string,
  userEmail?: string,
  displayName?: string,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  try {
    await query(
      `INSERT INTO apex_ms_tokens (user_email, display_name, access_token, refresh_token, expires_at, connected_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connected_by) DO UPDATE SET
         user_email = EXCLUDED.user_email,
         display_name = COALESCE(EXCLUDED.display_name, apex_ms_tokens.display_name),
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [userEmail || tokens.user_email, displayName || tokens.display_name || null, tokens.access_token, tokens.refresh_token, tokens.expires_at, userId],
    );
  } catch (err) {
    console.error("[microsoft-graph] Failed to store tokens:", (err as Error).message);
  }
}

/**
 * Get a valid (non-expired) access token for a SPECIFIC apex user,
 * auto-refreshing if needed. Returns null if that user has no token
 * stored or refresh fails. Never returns another user's token.
 */
export async function getValidToken(
  userId: string,
): Promise<{ accessToken: string; userEmail: string } | null> {
  if (isShadowMode()) return null;
  if (!userId) return null;

  const { rows } = await safeQuery<{
    access_token: string;
    refresh_token: string;
    user_email: string;
    expires_at: string;
    connected_by: string;
  }>(
    `SELECT access_token, refresh_token, user_email, expires_at, connected_by
     FROM apex_ms_tokens
     WHERE connected_by = $1
     LIMIT 1`,
    [userId],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const expiresAt = new Date(row.expires_at).getTime();
  const bufferMs = 5 * 60 * 1000; // refresh 5 min before expiry

  if (Date.now() < expiresAt - bufferMs) {
    return { accessToken: row.access_token, userEmail: row.user_email };
  }

  // Token expired or expiring soon — refresh
  const refreshed = await refreshAccessToken(row.refresh_token);
  if (!refreshed) {
    trackEvent("microsoft.token_refresh_failed", userId, "system", {
      user_email: row.user_email,
    });
    return null;
  }

  refreshed.user_email = row.user_email;
  await storeTokens(refreshed, userId, row.user_email);

  trackEvent("microsoft.token_refreshed", userId, "system", {
    user_email: row.user_email,
  });

  return { accessToken: refreshed.access_token, userEmail: row.user_email };
}

/**
 * Delete stored Microsoft tokens for a specific apex user (disconnect).
 * Only clears that user's row and that user's cache namespace.
 */
export async function deleteTokens(userId: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  if (!userId) return;

  try {
    await query(`DELETE FROM apex_ms_tokens WHERE connected_by = $1`, [userId]);
    clearCache(userId);
  } catch (err) {
    console.error("[microsoft-graph] Failed to delete tokens:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Graph API Wrapper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Microsoft Graph API.
 * Endpoint should be relative to https://graph.microsoft.com/v1.0/
 */
export async function graphFetch<T = unknown>(
  endpoint: string,
  accessToken: string,
  userId: string,
): Promise<T | null> {
  const url = `${GRAPH_BASE_URL}/${endpoint}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    trackEvent("microsoft.api_called", userId, "system", {
      endpoint,
      status: res.status,
    });

    if (!res.ok) {
      console.error(`[microsoft-graph] API error ${res.status} for ${endpoint}:`, await res.text());
      trackEvent("microsoft.fetch_failed", userId, "system", {
        endpoint,
        status: res.status,
      });
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.error(`[microsoft-graph] API fetch error for ${endpoint}:`, (err as Error).message);
    trackEvent("microsoft.fetch_failed", userId, "system", {
      endpoint,
      status: 0,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection Status
// ---------------------------------------------------------------------------

/**
 * Get the Microsoft Graph connection status for a SPECIFIC apex user.
 * Never returns another user's connection.
 */
export async function getConnectionStatus(userId: string): Promise<MsConnectionStatus> {
  if (isShadowMode()) {
    return {
      connected: false,
      userEmail: null,
      displayName: null,
      lastSync: null,
      mode: "shadow",
    };
  }
  if (!userId) {
    return { connected: false, userEmail: null, displayName: null, lastSync: null, mode: "live" };
  }

  const { rows } = await safeQuery<{
    user_email: string;
    display_name: string | null;
    updated_at: string;
  }>(
    `SELECT user_email, display_name, updated_at
     FROM apex_ms_tokens
     WHERE connected_by = $1
     LIMIT 1`,
    [userId],
  );

  if (rows.length === 0) {
    return { connected: false, userEmail: null, displayName: null, lastSync: null, mode: "live" };
  }

  return {
    connected: true,
    userEmail: rows[0].user_email,
    displayName: rows[0].display_name,
    lastSync: rows[0].updated_at,
    mode: "live",
  };
}

// ---------------------------------------------------------------------------
// Data Fetchers — Live Mode
// ---------------------------------------------------------------------------

async function fetchLiveCalendarEvents(userId: string, startDate: string, endDate: string): Promise<CalendarEvent[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const start = new Date(startDate).toISOString();
  const end = new Date(endDate).toISOString();

  const data = await graphFetch<{
    value?: {
      id: string;
      subject: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      location?: { displayName?: string };
      attendees?: { emailAddress: { name: string; address: string } }[];
      isOnlineMeeting?: boolean;
    }[];
  }>(
    `me/calendarview?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,location,attendees,isOnlineMeeting`,
    token.accessToken,
    userId,
  );

  if (!data?.value) return [];

  return data.value.map((ev) => ({
    id: ev.id,
    subject: ev.subject,
    start: ev.start.dateTime,
    end: ev.end.dateTime,
    location: ev.location?.displayName || "",
    attendees: (ev.attendees || []).map((a) => a.emailAddress.name || a.emailAddress.address),
    isOnlineMeeting: ev.isOnlineMeeting || false,
  }));
}

async function fetchLiveRecentEmails(userId: string, count: number, folderId?: string): Promise<Email[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const folder = folderId || "inbox";
  const data = await graphFetch<{
    value?: {
      id: string;
      subject: string;
      from: { emailAddress: { name: string; address: string } };
      receivedDateTime: string;
      bodyPreview: string;
      isRead: boolean;
      importance: string;
    }[];
  }>(
    `me/mailFolders/${folder}/messages?$top=${count}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,importance`,
    token.accessToken,
    userId,
  );

  if (!data?.value) return [];

  return data.value.map((msg) => ({
    id: msg.id,
    subject: msg.subject,
    from: msg.from.emailAddress.name || msg.from.emailAddress.address,
    fromEmail: msg.from.emailAddress.address,
    receivedDateTime: msg.receivedDateTime,
    bodyPreview: msg.bodyPreview,
    isRead: msg.isRead,
    importance: (msg.importance?.toLowerCase() || "normal") as "low" | "normal" | "high",
  }));
}

async function fetchLiveEmailsFromContact(userId: string, email: string, count: number): Promise<Email[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const filter = encodeURIComponent(`from/emailAddress/address eq '${email}'`);
  const data = await graphFetch<{
    value?: {
      id: string;
      subject: string;
      from: { emailAddress: { name: string; address: string } };
      receivedDateTime: string;
      bodyPreview: string;
      isRead: boolean;
      importance: string;
    }[];
  }>(
    `me/messages?$filter=${filter}&$top=${count}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,importance`,
    token.accessToken,
    userId,
  );

  if (!data?.value) return [];

  return data.value.map((msg) => ({
    id: msg.id,
    subject: msg.subject,
    from: msg.from.emailAddress.name || msg.from.emailAddress.address,
    fromEmail: msg.from.emailAddress.address,
    receivedDateTime: msg.receivedDateTime,
    bodyPreview: msg.bodyPreview,
    isRead: msg.isRead,
    importance: (msg.importance?.toLowerCase() || "normal") as "low" | "normal" | "high",
  }));
}

async function fetchLiveContacts(userId: string, count: number): Promise<Contact[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const data = await graphFetch<{
    value?: {
      id: string;
      displayName: string;
      emailAddresses?: { address: string }[];
      companyName?: string;
      jobTitle?: string;
      mobilePhone?: string;
      businessPhones?: string[];
    }[];
  }>(
    `me/contacts?$top=${count}&$orderby=displayName&$select=id,displayName,emailAddresses,companyName,jobTitle,mobilePhone,businessPhones`,
    token.accessToken,
    userId,
  );

  if (!data?.value) return [];

  return data.value.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    emailAddresses: (c.emailAddresses || []).map((e) => e.address),
    companyName: c.companyName || "",
    jobTitle: c.jobTitle || "",
    phone: c.mobilePhone || c.businessPhones?.[0] || "",
  }));
}

async function fetchLiveUnreadCount(userId: string): Promise<number> {
  const token = await getValidToken(userId);
  if (!token) return 0;

  const data = await graphFetch<{
    unreadItemCount?: number;
  }>(
    "me/mailFolders/inbox?$select=unreadItemCount",
    token.accessToken,
    userId,
  );

  return data?.unreadItemCount || 0;
}

async function fetchLiveUserProfile(userId: string): Promise<UserProfile | null> {
  const token = await getValidToken(userId);
  if (!token) return null;

  const data = await graphFetch<{
    displayName: string;
    mail: string;
    userPrincipalName: string;
    jobTitle?: string;
  }>(
    "me?$select=displayName,mail,userPrincipalName,jobTitle",
    token.accessToken,
    userId,
  );

  if (!data) return null;

  // Try to get profile photo URL — Graph returns 404 if no photo is set
  let photoUrl: string | null = null;
  try {
    const photoRes = await fetch(`${GRAPH_BASE_URL}/me/photo/$value`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (photoRes.ok) {
      // Photo exists — client can use this endpoint directly with the token
      photoUrl = `${GRAPH_BASE_URL}/me/photo/$value`;
    }
  } catch {
    // No photo available
  }

  return {
    displayName: data.displayName,
    email: data.mail || data.userPrincipalName,
    jobTitle: data.jobTitle || "",
    photoUrl,
  };
}

// ---------------------------------------------------------------------------
// Shadow Mode Demo Data (realistic CEO day at a marketing/tech agency)
// ---------------------------------------------------------------------------

function todayAt(hours: number, minutes: number): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

function pastDateTime(daysAgo: number, hours: number, minutes: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

function demoCalendarEvents(): CalendarEvent[] {
  return [
    {
      id: "evt-001",
      subject: "Greenfield Corp — Q2 Strategy Review",
      start: todayAt(9, 0),
      end: todayAt(10, 0),
      location: "Teams",
      attendees: ["Sarah Chen", "Mark Rivera", "James Greenfield"],
      isOnlineMeeting: true,
    },
    {
      id: "evt-002",
      subject: "Daily Standup",
      start: todayAt(10, 15),
      end: todayAt(10, 30),
      location: "Slack Huddle",
      attendees: ["Dev Team", "Sarah Chen", "Alex Park"],
      isOnlineMeeting: true,
    },
    {
      id: "evt-003",
      subject: "Prospect Call — Meridian Health Systems",
      start: todayAt(11, 0),
      end: todayAt(11, 45),
      location: "Zoom",
      attendees: ["Dr. Lisa Tran", "Mike Owens"],
      isOnlineMeeting: true,
    },
    {
      id: "evt-004",
      subject: "Lunch — Cedar & Stone Partnership",
      start: todayAt(12, 30),
      end: todayAt(13, 30),
      location: "Bistro 44, Downtown",
      attendees: ["Rachel Stone"],
      isOnlineMeeting: false,
    },
    {
      id: "evt-005",
      subject: "Horizon Digital — Sprint Demo & Feedback",
      start: todayAt(14, 0),
      end: todayAt(15, 0),
      location: "Google Meet",
      attendees: ["Emily Watts", "Carlos Mendez", "Sarah Chen"],
      isOnlineMeeting: true,
    },
    {
      id: "evt-006",
      subject: "Internal — Product Roadmap & Pricing Review",
      start: todayAt(16, 0),
      end: todayAt(17, 0),
      location: "Conference Room A",
      attendees: ["Sarah Chen", "Alex Park", "Jordan Lee"],
      isOnlineMeeting: false,
    },
  ];
}

function demoRecentEmails(): Email[] {
  return [
    {
      id: "mail-001",
      subject: "RE: Q2 Retainer Agreement — Final Terms",
      from: "James Greenfield",
      fromEmail: "james@greenfieldcorp.com",
      receivedDateTime: pastDateTime(0, 8, 42),
      bodyPreview: "Nick, looks great. Legal approved the SOW yesterday. We can sign digitally today if you send over the DocuSign link...",
      isRead: false,
      importance: "high",
    },
    {
      id: "mail-002",
      subject: "Invoice #1047 — Payment Scheduled",
      from: "AP Department",
      fromEmail: "ap@greenfieldcorp.com",
      receivedDateTime: pastDateTime(0, 8, 15),
      bodyPreview: "This confirms that Invoice #1047 for $8,500.00 has been approved and scheduled for ACH payment on...",
      isRead: false,
      importance: "normal",
    },
    {
      id: "mail-003",
      subject: "Sprint 14 Deployment — All Green",
      from: "Sarah Chen",
      fromEmail: "sarah@wolfpack.dev",
      receivedDateTime: pastDateTime(0, 7, 55),
      bodyPreview: "Morning! Sprint 14 deployed to production at 7:30am. All 47 tests passing, Lighthouse scores holding at 94+. The new...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-004",
      subject: "Interested in your AI consulting services",
      from: "Dr. Lisa Tran",
      fromEmail: "ltran@meridianhealthsys.com",
      receivedDateTime: pastDateTime(0, 7, 30),
      bodyPreview: "Hi Nick, I was referred to Wolfpack by Carlos at Horizon Digital. We're looking to integrate predictive analytics into our...",
      isRead: false,
      importance: "normal",
    },
    {
      id: "mail-005",
      subject: "RE: Apex Media — Brand Refresh Mockups",
      from: "Priya Sharma",
      fromEmail: "priya@apexmediagroup.com",
      receivedDateTime: pastDateTime(0, 6, 45),
      bodyPreview: "The team loved Option B with the gradient treatment! Can we schedule a follow-up to discuss the motion design...",
      isRead: false,
      importance: "normal",
    },
    {
      id: "mail-006",
      subject: "Summit Analytics — Data Pipeline Proposal",
      from: "Tom Barrett",
      fromEmail: "tbarrett@summitanalytics.io",
      receivedDateTime: pastDateTime(1, 16, 20),
      bodyPreview: "Nick, attached is the revised proposal for the ETL pipeline build. We adjusted scope based on your feedback about...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-007",
      subject: "Your AWS bill for March 2026",
      from: "Amazon Web Services",
      fromEmail: "no-reply@aws.amazon.com",
      receivedDateTime: pastDateTime(1, 14, 0),
      bodyPreview: "Your AWS charges for the billing period March 1–31, 2026 are $2,847.32. This includes EC2, RDS, S3, and CloudFront...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-008",
      subject: "Cedar & Stone — Launch Day Checklist",
      from: "Rachel Stone",
      fromEmail: "rachel@cedarandstone.co",
      receivedDateTime: pastDateTime(1, 11, 30),
      bodyPreview: "Hi Nick! Just confirming everything for Thursday's soft launch. The staging site looks incredible. A few items from our side...",
      isRead: true,
      importance: "high",
    },
    {
      id: "mail-009",
      subject: "Team Offsite — Venue Options",
      from: "Jordan Lee",
      fromEmail: "jordan@wolfpack.dev",
      receivedDateTime: pastDateTime(1, 10, 15),
      bodyPreview: "Hey! Found three great options for the May offsite. The lakehouse in Lake Geneva has availability May 16-18 and...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-010",
      subject: "Vercel Pro — Usage Alert",
      from: "Vercel",
      fromEmail: "notifications@vercel.com",
      receivedDateTime: pastDateTime(1, 9, 0),
      bodyPreview: "Your team has used 82% of included bandwidth for this billing cycle. Consider upgrading to Enterprise for...",
      isRead: true,
      importance: "low",
    },
    {
      id: "mail-011",
      subject: "RE: Horizon Digital — Phase 2 Kickoff",
      from: "Emily Watts",
      fromEmail: "emily.watts@horizondigital.com",
      receivedDateTime: pastDateTime(2, 15, 45),
      bodyPreview: "Confirmed — our product team will join the kickoff on Monday. Carlos will present the user research findings and...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-012",
      subject: "New lead from website — Enterprise inquiry",
      from: "Wolfpack Website",
      fromEmail: "leads@wolfpack.dev",
      receivedDateTime: pastDateTime(2, 13, 20),
      bodyPreview: "New form submission: Company: Pinnacle Group, Contact: David Park, Email: dpark@pinnaclegroup.com, Message: Looking for...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-013",
      subject: "E&O Insurance Renewal — Action Required",
      from: "Hartford Insurance",
      fromEmail: "renewals@hartford.com",
      receivedDateTime: pastDateTime(2, 10, 0),
      bodyPreview: "Your Errors & Omissions policy #WP-2025-4471 expires on May 15, 2026. We've prepared a renewal quote with the same...",
      isRead: false,
      importance: "high",
    },
    {
      id: "mail-014",
      subject: "Alex's PTO Request — April 14-18",
      from: "Alex Park",
      fromEmail: "alex@wolfpack.dev",
      receivedDateTime: pastDateTime(3, 9, 30),
      bodyPreview: "Hey Nick, requesting PTO April 14-18 for a family trip. I'll make sure the Greenfield deliverables are ahead of...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-015",
      subject: "GitHub Actions — Monthly Usage Report",
      from: "GitHub",
      fromEmail: "noreply@github.com",
      receivedDateTime: pastDateTime(3, 8, 0),
      bodyPreview: "Your organization nhomyk used 1,847 of 2,000 included minutes this billing period. Top repositories by usage: wolfpack-auto...",
      isRead: true,
      importance: "low",
    },
    {
      id: "mail-016",
      subject: "Webinar: AI in Agency Operations — You're Registered",
      from: "HubSpot",
      fromEmail: "events@hubspot.com",
      receivedDateTime: pastDateTime(4, 12, 0),
      bodyPreview: "Thanks for registering! Join us April 10 at 2pm ET for 'AI-Powered Agency Operations' featuring case studies from...",
      isRead: true,
      importance: "low",
    },
    {
      id: "mail-017",
      subject: "RE: Contractor Agreement — Sarah K.",
      from: "Sarah Kim",
      fromEmail: "sarah.k@freelance.dev",
      receivedDateTime: pastDateTime(4, 11, 15),
      bodyPreview: "Hi Nick, the updated contractor agreement looks good. I've signed and returned via DocuSign. Looking forward to starting on...",
      isRead: true,
      importance: "normal",
    },
    {
      id: "mail-018",
      subject: "Apex Media — Campaign Performance Report",
      from: "Priya Sharma",
      fromEmail: "priya@apexmediagroup.com",
      receivedDateTime: pastDateTime(5, 14, 30),
      bodyPreview: "Attached is the Q1 campaign performance report. Key highlights: 34% increase in organic traffic, conversion rate up to 4.2%...",
      isRead: true,
      importance: "normal",
    },
  ];
}

function demoContacts(): Contact[] {
  return [
    {
      id: "contact-001",
      displayName: "James Greenfield",
      emailAddresses: ["james@greenfieldcorp.com"],
      companyName: "Greenfield Corp",
      jobTitle: "CEO",
      phone: "(555) 234-5678",
    },
    {
      id: "contact-002",
      displayName: "Emily Watts",
      emailAddresses: ["emily.watts@horizondigital.com"],
      companyName: "Horizon Digital",
      jobTitle: "VP of Product",
      phone: "(555) 345-6789",
    },
    {
      id: "contact-003",
      displayName: "Carlos Mendez",
      emailAddresses: ["carlos@horizondigital.com"],
      companyName: "Horizon Digital",
      jobTitle: "Head of Engineering",
      phone: "(555) 345-6790",
    },
    {
      id: "contact-004",
      displayName: "Priya Sharma",
      emailAddresses: ["priya@apexmediagroup.com"],
      companyName: "Apex Media Group",
      jobTitle: "Marketing Director",
      phone: "(555) 456-7890",
    },
    {
      id: "contact-005",
      displayName: "Tom Barrett",
      emailAddresses: ["tbarrett@summitanalytics.io"],
      companyName: "Summit Analytics",
      jobTitle: "CTO",
      phone: "(555) 567-8901",
    },
    {
      id: "contact-006",
      displayName: "Rachel Stone",
      emailAddresses: ["rachel@cedarandstone.co"],
      companyName: "Cedar & Stone",
      jobTitle: "Founder",
      phone: "(555) 678-9012",
    },
    {
      id: "contact-007",
      displayName: "Dr. Lisa Tran",
      emailAddresses: ["ltran@meridianhealthsys.com"],
      companyName: "Meridian Health Systems",
      jobTitle: "Chief Data Officer",
      phone: "(555) 789-0123",
    },
    {
      id: "contact-008",
      displayName: "Sarah Chen",
      emailAddresses: ["sarah@wolfpack.dev"],
      companyName: "Wolfpack Agency",
      jobTitle: "Lead Developer",
      phone: "(555) 867-5310",
    },
    {
      id: "contact-009",
      displayName: "Alex Park",
      emailAddresses: ["alex@wolfpack.dev"],
      companyName: "Wolfpack Agency",
      jobTitle: "Senior Developer",
      phone: "(555) 867-5311",
    },
    {
      id: "contact-010",
      displayName: "Jordan Lee",
      emailAddresses: ["jordan@wolfpack.dev"],
      companyName: "Wolfpack Agency",
      jobTitle: "Operations Manager",
      phone: "(555) 867-5312",
    },
    {
      id: "contact-011",
      displayName: "Sarah Kim",
      emailAddresses: ["sarah.k@freelance.dev"],
      companyName: "Freelance",
      jobTitle: "UI/UX Designer (Contractor)",
      phone: "(555) 890-1234",
    },
    {
      id: "contact-012",
      displayName: "David Park",
      emailAddresses: ["dpark@pinnaclegroup.com"],
      companyName: "Pinnacle Group",
      jobTitle: "Director of Technology",
      phone: "(555) 901-2345",
    },
    {
      id: "contact-013",
      displayName: "Mike Owens",
      emailAddresses: ["mowens@meridianhealthsys.com"],
      companyName: "Meridian Health Systems",
      jobTitle: "VP of Operations",
      phone: "(555) 789-0124",
    },
  ];
}

function demoEmailsFromContact(email: string, count: number): Email[] {
  // Filter demo emails by the requested contact email
  const all = demoRecentEmails().filter((e) => e.fromEmail === email);
  return all.slice(0, count);
}

function demoUserProfile(): UserProfile {
  return {
    displayName: "Nick Homyk",
    email: "ceo@wolfpack.dev",
    jobTitle: "CEO & Founder",
    photoUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Public Fetchers (cached, shadow-aware)
// ---------------------------------------------------------------------------

/**
 * Fetch calendar events for the given date range.
 * Returns today's and upcoming meetings with subjects, times, and attendees.
 */
export async function fetchCalendarEvents(userId: string, startDate: string, endDate: string): Promise<CalendarEvent[]> {
  const cacheKey = `${userId}:ms-calendar:${startDate}:${endDate}`;
  const cached = getCached<CalendarEvent[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoCalendarEvents()
    : await fetchLiveCalendarEvents(userId, startDate, endDate);

  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch recent emails from the inbox (or a specific folder).
 * Returns subject, sender, preview, read status, and importance.
 */
export async function fetchRecentEmails(userId: string, count: number = 15, folderId?: string): Promise<Email[]> {
  const cacheKey = `${userId}:ms-emails:${count}:${folderId || "inbox"}`;
  const cached = getCached<Email[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoRecentEmails().slice(0, count)
    : await fetchLiveRecentEmails(userId, count, folderId);

  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch emails exchanged with a specific contact by email address.
 */
export async function fetchEmailsFromContact(userId: string, email: string, count: number = 10): Promise<Email[]> {
  const cacheKey = `${userId}:ms-emails-from:${email}:${count}`;
  const cached = getCached<Email[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoEmailsFromContact(email, count)
    : await fetchLiveEmailsFromContact(userId, email, count);

  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch Outlook contacts with name, email, company, title, and phone.
 */
export async function fetchContacts(userId: string, count: number = 15): Promise<Contact[]> {
  const cacheKey = `${userId}:ms-contacts:${count}`;
  const cached = getCached<Contact[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoContacts().slice(0, count)
    : await fetchLiveContacts(userId, count);

  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch the number of unread emails in the inbox.
 */
export async function fetchUnreadCount(userId: string): Promise<number> {
  const cacheKey = `${userId}:ms-unread-count`;
  const cached = getCached<number>(cacheKey);
  if (cached !== null) return cached;

  const result = isShadowMode() ? 7 : await fetchLiveUnreadCount(userId);

  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch the current user's profile (name, email, job title, photo).
 */
export async function fetchUserProfile(userId: string): Promise<UserProfile | null> {
  const cacheKey = `${userId}:ms-user-profile`;
  const cached = getCached<UserProfile>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoUserProfile() : await fetchLiveUserProfile(userId);
  if (result) setCache(cacheKey, result);
  return result;
}
