/**
 * Morning Briefing Generator — CEO/CTO daily intelligence digest.
 *
 * Assembles data from QuickBooks, Microsoft Graph, knowledge base,
 * and journal entries into a single actionable briefing.
 *
 * Shadow mode: returns realistic demo data for a 5-person agency CEO.
 * Cached for 30 minutes to avoid redundant computation.
 */

import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";
import {
  fetchProfitAndLoss,
  fetchBalanceSheet,
  fetchUnpaidInvoices,
  fetchRecentPayments,
  fetchAgedReceivables,
  getConnectionStatus as getQboConnectionStatus,
} from "@/lib/quickbooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  subject: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  location?: string;
}

export interface ImportantEmail {
  from: string;
  subject: string;
  receivedAt: string;
  preview: string;
  /** Microsoft Graph message id, when available. Used to deep-link the
   *  ActionItem into the inbox reader. */
  id?: string;
  /** Outlook webLink fallback when in-app deep-link is unavailable. */
  webLink?: string;
}

export interface ActionItem {
  priority: "high" | "medium" | "low";
  text: string;
  context: string;
  /** Optional URL the dashboard renders as a click-through. Internal
   *  paths (/emails?messageId=...) are preferred over external Outlook
   *  webLinks; both formats are accepted by the renderer. */
  link?: string;
  /** Stable analytics key for this action item — `email`, `meeting`,
   *  `invoice`, etc. Tied into dashboard.action_item_clicked. */
  source?: "email" | "meeting" | "invoice" | "client" | "receivable";
}

export interface ClientAttention {
  name: string;
  reason: string;
  lastContact: string | null;
}

export interface MorningBriefing {
  generatedAt: string;
  greeting: string;
  summary: string;
  calendar: {
    eventCount: number;
    nextEvent: { subject: string; startTime: string; attendees: string[] } | null;
    events: CalendarEvent[];
  };
  email: {
    unreadCount: number;
    importantEmails: ImportantEmail[];
  };
  financial: {
    cashPosition: number;
    revenueThisMonth: number;
    netProfit: number;
    unpaidInvoiceCount: number;
    overdueCount: number;
    recentPayments: { customer: string; amount: number }[];
  };
  clients: {
    needingAttention: ClientAttention[];
  };
  team: {
    activeMembers: number;
    recentHighlights: string[];
  };
  actionItems: ActionItem[];
  notConnected?: boolean;
}

// ---------------------------------------------------------------------------
// Cache (30-minute TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  data: MorningBriefing;
  expiresAt: number;
}

const briefingCache = new Map<string, CacheEntry>();

function getCached(userId: string): MorningBriefing | null {
  const entry = briefingCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    briefingCache.delete(userId);
    return null;
  }
  return entry.data;
}

function setCache(userId: string, data: MorningBriefing): void {
  briefingCache.set(userId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Greeting helper
// ---------------------------------------------------------------------------

function getGreeting(name: string): string {
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${name}`;
  if (hour < 17) return `Good afternoon, ${name}`;
  return `Good evening, ${name}`;
}

// ---------------------------------------------------------------------------
// Microsoft Graph — graceful import
// ---------------------------------------------------------------------------

async function fetchMsGraphData(userId: string): Promise<{
  calendar: CalendarEvent[];
  emails: {
    id?: string;
    from: string;
    subject: string;
    receivedDateTime: string;
    bodyPreview: string;
    webLink?: string;
  }[];
  unreadCount: number;
} | null> {
  try {
    // Dynamic import — microsoft-graph.ts may not exist yet
    const msGraph = await import("@/lib/microsoft-graph");
    // Only fetch if THIS user is actually connected (not shadow/demo)
    const msStatus = await msGraph.getConnectionStatus(userId);
    if (!msStatus.connected) return null;

    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [calendarEvents, emails, unreadCount] = await Promise.all([
      msGraph.fetchCalendarEvents(userId, today, tomorrow),
      msGraph.fetchRecentEmails(userId, 10),
      msGraph.fetchUnreadCount(userId),
    ]);

    return {
      calendar: (calendarEvents || []).map((e: { subject: string; start: string; end: string; attendees: string[]; location?: string }) => ({
        subject: e.subject,
        startTime: e.start,
        endTime: e.end,
        attendees: e.attendees || [],
        location: e.location,
      })),
      emails: (emails || []).map(
        (e: {
          id?: string;
          from: string;
          subject: string;
          receivedDateTime: string;
          bodyPreview: string;
          webLink?: string;
        }) => ({
          id: e.id,
          from: e.from,
          subject: e.subject,
          receivedDateTime: e.receivedDateTime,
          bodyPreview: e.bodyPreview,
          webLink: e.webLink,
        }),
      ),
      unreadCount: unreadCount ?? 0,
    };
  } catch {
    // Module not available yet — fall back to demo data
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchFinancialData() {
  // Only fetch if QuickBooks is actually connected (not shadow/demo)
  const qboStatus = await getQboConnectionStatus();
  if (!qboStatus.connected) return null;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const today = now.toISOString().split("T")[0];

  const [pnl, balanceSheet, unpaidInvoices, recentPayments, agedReceivables] = await Promise.all([
    fetchProfitAndLoss(startOfMonth, today),
    fetchBalanceSheet(),
    fetchUnpaidInvoices(),
    fetchRecentPayments(5),
    fetchAgedReceivables(),
  ]);

  // Extract cash position from balance sheet
  const cashAssets = balanceSheet?.assets?.filter(
    (a) =>
      a.name.toLowerCase().includes("cash") ||
      a.name.toLowerCase().includes("checking") ||
      a.name.toLowerCase().includes("savings"),
  ) || [];
  const cashPosition = cashAssets.reduce((sum, a) => sum + a.amount, 0) || (balanceSheet?.totalAssets ?? 0) * 0.3;

  // Count overdue invoices
  const overdueInvoices = unpaidInvoices.filter((inv) => new Date(inv.dueDate) < now);

  return {
    cashPosition,
    revenueThisMonth: pnl?.totalIncome ?? 0,
    netProfit: pnl?.netIncome ?? 0,
    unpaidInvoiceCount: unpaidInvoices.length,
    overdueCount: overdueInvoices.length,
    recentPayments: recentPayments.map((p) => ({
      customer: p.customerName,
      amount: p.amount,
    })),
    // Keep raw data for action item generation
    _overdueInvoices: overdueInvoices,
    _agedReceivables: agedReceivables,
  };
}

async function fetchTeamActivity(): Promise<{ activeMembers: number; recentHighlights: string[] }> {
  const { rows } = await safeQuery<{ user_id: string; event_type: string; metadata: string }>(
    `SELECT DISTINCT user_id, event_type, metadata
     FROM instinct_events
     WHERE timestamp > NOW() - INTERVAL '24 hours'
       AND event_type NOT IN ('system.page_viewed', 'system.login')
     ORDER BY timestamp DESC
     LIMIT 20`,
  );

  if (rows.length === 0) {
    return { activeMembers: 0, recentHighlights: [] };
  }

  const uniqueUsers = new Set(rows.map((r) => r.user_id));
  const highlights: string[] = [];

  const eventDescriptions: Record<string, string> = {
    "knowledge.doc_generated": "generated a knowledge doc",
    "knowledge.question_asked": "asked a knowledge base question",
    "feature.request_submitted": "submitted a feature request",
    "feature.request_approved": "approved a feature request",
    "discussion.thread_created": "started a new discussion",
    "discussion.resolved": "resolved a discussion",
    "journal.entry_created": "wrote a journal entry",
    "client.proposal_created": "created a client proposal",
    "client.doc_generated": "generated a client document",
    "prototype.created": "created a prototype",
    "prototype.deployed": "deployed a prototype",
  };

  for (const row of rows.slice(0, 5)) {
    const desc = eventDescriptions[row.event_type];
    if (desc) {
      highlights.push(`${row.user_id} ${desc}`);
    }
  }

  return { activeMembers: uniqueUsers.size, recentHighlights: highlights };
}

async function fetchClientAttention(): Promise<ClientAttention[]> {
  // Check for clients with no recent activity
  const { rows } = await safeQuery<{ name: string; last_contact: string | null }>(
    `SELECT c.name,
            MAX(e.timestamp) AS last_contact
     FROM instinct_clients c
     LEFT JOIN instinct_events e ON e.metadata::text LIKE '%' || c.name || '%'
       AND e.timestamp > NOW() - INTERVAL '30 days'
     GROUP BY c.name
     ORDER BY last_contact ASC NULLS FIRST
     LIMIT 5`,
  );

  return rows
    .filter((r) => {
      if (!r.last_contact) return true;
      const daysSince = (Date.now() - new Date(r.last_contact).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 7;
    })
    .map((r) => {
      const daysSince = r.last_contact
        ? Math.floor((Date.now() - new Date(r.last_contact).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      return {
        name: r.name,
        reason: daysSince
          ? `No contact in ${daysSince} days`
          : "No recorded interactions",
        lastContact: r.last_contact,
      };
    });
}

// ---------------------------------------------------------------------------
// Action item generation
// ---------------------------------------------------------------------------

function generateActionItems(
  financial: Awaited<ReturnType<typeof fetchFinancialData>> | null,
  calendar: CalendarEvent[],
  emails: ImportantEmail[],
  clients: ClientAttention[],
): ActionItem[] {
  const items: ActionItem[] = [];

  // High priority: overdue invoices (CEO only, when financial data available)
  for (const inv of (financial?._overdueInvoices ?? []).slice(0, 3)) {
    const daysPast = Math.floor(
      (Date.now() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24),
    );
    items.push({
      priority: "high",
      text: `Follow up on overdue invoice from ${inv.customerName}`,
      context: `$${inv.balance.toLocaleString()} outstanding, ${daysPast} days past due`,
    });
  }

  // High priority: aged receivables over 60 days
  if (financial?._agedReceivables) {
    const over60 = financial._agedReceivables.days61to90 + (financial._agedReceivables.over90 || 0);
    if (over60 > 0) {
      items.push({
        priority: "high",
        text: "Review aged receivables over 60 days",
        context: `$${over60.toLocaleString()} in receivables past 60 days`,
      });
    }
  }

  // Medium priority: upcoming meetings needing prep
  const upcomingMeetings = calendar.filter((e) => {
    const start = new Date(e.startTime);
    const hoursUntil = (start.getTime() - Date.now()) / (1000 * 60 * 60);
    return hoursUntil > 0 && hoursUntil < 4 && e.attendees.length > 1;
  });
  for (const meeting of upcomingMeetings.slice(0, 2)) {
    items.push({
      priority: "medium",
      text: `Prepare for "${meeting.subject}"`,
      context: `${meeting.attendees.length} attendees, starts at ${new Date(meeting.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    });
  }

  // Medium priority: important unread emails
  for (const email of emails.slice(0, 2)) {
    /* Prefer in-app /emails deep-link by message id; fall back to the
       Outlook webLink (opens in a new tab) when we don't have an id.
       The dashboard renderer treats absolute URLs as target=_blank. */
    const link = email.id
      ? `/emails?messageId=${encodeURIComponent(email.id)}`
      : email.webLink || undefined;
    items.push({
      priority: "medium",
      text: `Respond to ${email.from}`,
      context: email.subject,
      source: "email",
      link,
    });
  }

  // Low priority: clients needing attention
  for (const client of clients.slice(0, 3)) {
    items.push({
      priority: "low",
      text: `Check in with ${client.name}`,
      context: client.reason,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

function generateSummary(briefing: Omit<MorningBriefing, "summary">): string {
  const parts: string[] = [];

  if (briefing.calendar.eventCount > 0) {
    parts.push(
      `You have ${briefing.calendar.eventCount} meeting${briefing.calendar.eventCount !== 1 ? "s" : ""} today`,
    );
  } else {
    parts.push("Your calendar is clear today");
  }

  if (briefing.email.unreadCount > 0) {
    parts.push(`${briefing.email.unreadCount} unread email${briefing.email.unreadCount !== 1 ? "s" : ""}`);
  }

  const highPriority = briefing.actionItems.filter((a) => a.priority === "high").length;
  if (highPriority > 0) {
    parts.push(
      `${highPriority} item${highPriority !== 1 ? "s" : ""} needing immediate attention`,
    );
  }

  if (briefing.financial.netProfit > 0) {
    parts.push(
      `$${Math.round(briefing.financial.netProfit).toLocaleString()} net profit MTD`,
    );
  }

  return parts.join(", ") + ".";
}

// ---------------------------------------------------------------------------
// Shadow mode demo data
// ---------------------------------------------------------------------------

function getDemoBriefing(userName: string): MorningBriefing {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const demoCalendar: CalendarEvent[] = [
    {
      subject: "Weekly Leadership Standup",
      startTime: `${today}T09:00:00`,
      endTime: `${today}T09:30:00`,
      attendees: ["Sarah Chen", "Mike Rivera", "Jordan Lee"],
    },
    {
      subject: "Greenfield Corp - Q2 Strategy Review",
      startTime: `${today}T10:30:00`,
      endTime: `${today}T11:30:00`,
      attendees: ["Tom Bradley (Greenfield)", "Sarah Chen"],
      location: "Zoom",
    },
    {
      subject: "Northstar Media Campaign Kickoff",
      startTime: `${today}T14:00:00`,
      endTime: `${today}T15:00:00`,
      attendees: ["Lisa Park (Northstar Media)", "Jordan Lee", "Mike Rivera"],
      location: "Conference Room A",
    },
    {
      subject: "1:1 with Sarah - Engineering Roadmap",
      startTime: `${today}T16:00:00`,
      endTime: `${today}T16:30:00`,
      attendees: ["Sarah Chen"],
    },
  ];

  const demoEmails: ImportantEmail[] = [
    {
      from: "Tom Bradley (Greenfield Corp)",
      subject: "Re: Q2 Budget Approval - Ready to Sign",
      receivedAt: `${today}T07:45:00`,
      preview: "Hi, we've reviewed the proposal and are ready to move forward with the $48K package. Can we finalize...",
    },
    {
      from: "Lisa Park (Northstar Media)",
      subject: "Campaign Assets - Need Creative Direction",
      receivedAt: `${today}T08:12:00`,
      preview: "The design team has three directions ready for review. Attached are the mockups. We need your sign-off by...",
    },
    {
      from: "Jordan Lee",
      subject: "Summit Analytics - Renewal Risk",
      receivedAt: `${today}T06:30:00`,
      preview: "Heads up: Summit Analytics mentioned budget cuts in yesterday's call. Their renewal is in 3 weeks and...",
    },
  ];

  const demoClients: ClientAttention[] = [
    {
      name: "Cedar & Stone",
      reason: "No contact in 12 days",
      lastContact: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      name: "Summit Analytics",
      reason: "Renewal in 3 weeks, budget concerns raised",
      lastContact: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const demoFinancial = {
    cashPosition: 142_850,
    revenueThisMonth: 67_400,
    netProfit: 23_180,
    unpaidInvoiceCount: 4,
    overdueCount: 2,
    recentPayments: [
      { customer: "Greenfield Corp", amount: 12_500 },
      { customer: "Horizon Digital", amount: 8_750 },
      { customer: "Northstar Media", amount: 15_000 },
    ],
  };

  const demoTeam = {
    activeMembers: 5,
    recentHighlights: [
      "Sarah Chen deployed the new client portal",
      "Mike Rivera closed the Horizon Digital renewal",
      "Jordan Lee submitted 3 feature requests from client feedback",
      "Alex Kim resolved 2 support tickets",
    ],
  };

  const actionItems: ActionItem[] = [
    {
      priority: "high",
      text: "Follow up on overdue invoice from Cedar & Stone",
      context: "$6,200 outstanding, 15 days past due",
    },
    {
      priority: "high",
      text: "Review Summit Analytics renewal strategy",
      context: "Renewal in 3 weeks, client mentioned budget cuts",
    },
    {
      priority: "medium",
      text: 'Prepare for "Greenfield Corp - Q2 Strategy Review"',
      context: "2 attendees, starts at 10:30 AM",
    },
    {
      priority: "medium",
      text: "Respond to Tom Bradley (Greenfield Corp)",
      context: "Re: Q2 Budget Approval - Ready to Sign",
    },
    {
      priority: "medium",
      text: "Review Northstar Media campaign creative direction",
      context: "Lisa Park needs sign-off on mockups today",
    },
    {
      priority: "low",
      text: "Check in with Cedar & Stone",
      context: "No contact in 12 days",
    },
  ];

  const briefingWithoutSummary = {
    generatedAt: now.toISOString(),
    greeting: getGreeting(userName),
    calendar: {
      eventCount: demoCalendar.length,
      nextEvent: {
        subject: demoCalendar[0].subject,
        startTime: demoCalendar[0].startTime,
        attendees: demoCalendar[0].attendees,
      },
      events: demoCalendar,
    },
    email: {
      unreadCount: 7,
      importantEmails: demoEmails,
    },
    financial: demoFinancial,
    clients: { needingAttention: demoClients },
    team: demoTeam,
    actionItems,
  };

  return {
    ...briefingWithoutSummary,
    summary: generateSummary(briefingWithoutSummary),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate or return cached morning briefing for a user.
 */
export async function generateBriefing(
  userId: string,
  userRole: string,
  options: { force?: boolean; userName?: string } = {},
): Promise<MorningBriefing> {
  // Check cache unless forced
  if (!options.force) {
    const cached = getCached(userId);
    if (cached) return cached;
  }

  const userName = options.userName || "there";

  // Determine if we can reach any live data
  const hasDb = !!process.env.DATABASE_URL;

  // Attempt to fetch all data in parallel (financials CEO only)
  const isCeo = userRole === "ceo";
  const [financialData, msGraphData, teamActivity, clientAttention] = await Promise.all([
    isCeo ? fetchFinancialData().catch(() => null) : Promise.resolve(null),
    fetchMsGraphData(userId).catch(() => null),
    hasDb ? fetchTeamActivity().catch(() => ({ activeMembers: 0, recentHighlights: [] })) : Promise.resolve(null),
    hasDb ? fetchClientAttention().catch(() => []) : Promise.resolve([]),
  ]);

  // If no integrations are connected, return a minimal briefing prompting connection
  const isFullShadow = !financialData && !msGraphData && !teamActivity;
  if (isFullShadow) {
    const emptyBriefing: MorningBriefing = {
      generatedAt: new Date().toISOString(),
      greeting: getGreeting(userName),
      summary: "Connect your accounts in Settings to unlock your personalized daily briefing.",
      calendar: { eventCount: 0, nextEvent: null, events: [] },
      email: { unreadCount: 0, importantEmails: [] },
      financial: { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] },
      clients: { needingAttention: [] },
      team: { activeMembers: 0, recentHighlights: [] },
      actionItems: [{
        priority: "medium",
        text: "Connect Microsoft 365 to get started",
        context: "Go to Settings > Integrations to link your Outlook calendar and email",
      }],
      notConnected: true,
    };
    setCache(userId, emptyBriefing);
    trackEvent("briefing.generated", userId, userRole, {
      source_count: 0,
      action_item_count: 1,
      mode: "not_connected",
    });
    return emptyBriefing;
  }

  // Build from live data with fallbacks
  const calendar: CalendarEvent[] = msGraphData?.calendar || [];
  const emails: ImportantEmail[] = (msGraphData?.emails || []).map(
    (e: {
      id?: string;
      from: string;
      subject: string;
      receivedDateTime: string;
      bodyPreview: string;
      webLink?: string;
    }) => ({
      from: e.from,
      subject: e.subject,
      receivedAt: e.receivedDateTime,
      preview: e.bodyPreview,
      id: e.id,
      webLink: e.webLink,
    }),
  );
  const unreadCount = msGraphData?.unreadCount ?? 0;

  const financial = financialData
    ? {
        cashPosition: financialData.cashPosition,
        revenueThisMonth: financialData.revenueThisMonth,
        netProfit: financialData.netProfit,
        unpaidInvoiceCount: financialData.unpaidInvoiceCount,
        overdueCount: financialData.overdueCount,
        recentPayments: financialData.recentPayments,
      }
    : { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] };

  const clients = { needingAttention: clientAttention || [] };
  const team = teamActivity || { activeMembers: 0, recentHighlights: [] };

  const actionItems = generateActionItems(
    financialData,
    calendar,
    emails,
    clients.needingAttention,
  );

  const briefingWithoutSummary = {
    generatedAt: new Date().toISOString(),
    greeting: getGreeting(userName),
    calendar: {
      eventCount: calendar.length,
      nextEvent: calendar.length > 0
        ? { subject: calendar[0].subject, startTime: calendar[0].startTime, attendees: calendar[0].attendees }
        : null,
      events: calendar,
    },
    email: { unreadCount, importantEmails: emails.slice(0, 5) },
    financial,
    clients,
    team,
    actionItems,
  };

  const briefing: MorningBriefing = {
    ...briefingWithoutSummary,
    summary: generateSummary(briefingWithoutSummary),
  };

  setCache(userId, briefing);

  // Count how many sources returned data
  let sourceCount = 0;
  if (financialData) sourceCount++;
  if (msGraphData) sourceCount++;
  if (teamActivity && teamActivity.activeMembers > 0) sourceCount++;

  trackEvent("briefing.generated", userId, userRole, {
    source_count: sourceCount,
    action_item_count: actionItems.length,
    mode: "live",
  });

  return briefing;
}
