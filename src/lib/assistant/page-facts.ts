/**
 * Page facts — zero-token, plain-English registry of every Instinct
 * dashboard page users can ask the assistant about.
 *
 * When a Wolfpack team member asks "what is the Calendar page?" or
 * "how do I track goals?", the assistant should answer with a rich
 * description of the page, what they can do there, and how to use it —
 * WITHOUT touching the AI API, and WITHOUT silently returning a stale
 * knowledge-base row that happens to mention the word "calendar".
 *
 * Every fact carries a `route` that the formatter embeds as a markdown
 * link, so the existing `detectRelatedPagesFromExchange` chip detector
 * picks the route up automatically — no extra payload field required.
 *
 * Copy guidelines:
 *   - Plain English. Dealer users, not devs. No "ingested", no
 *     "triple-write", no acronyms the UI doesn't already use.
 *   - Business verbs: "track", "book", "review", "follow up".
 *   - Domain nouns: OKRs, KRs, leads, clients, meetings, contacts.
 *   - 3–6 feature bullets, 2–4 "how to" steps. Short sentences.
 */

export interface PageFact {
  /** Domain key — must match a DOMAIN_MAP entry in related-pages.ts. */
  domain: string;
  /** Absolute route inside the Instinct app. No trailing slash. */
  route: string;
  /** Title shown at the top of the formatted answer. */
  title: string;
  /** One-sentence description of why the page exists. */
  purpose: string;
  /** 3–6 bullets describing what the user can do there. */
  what_you_can_do: string[];
  /** 2–4 ordered steps walking the user through a common task. */
  how_to: string[];
  /** 2–4 sibling domain keys whose chips belong beside this answer. */
  related_pages: string[];
}

/**
 * Keyed map of every page-facts entry. Covers the 26 pages the
 * assistant is expected to explain. Adding a new dashboard page?
 *   1. Add a matching `DOMAIN_MAP` entry in related-pages.ts.
 *   2. Add a PAGE_FACTS entry here.
 *   3. Add at least one test in page-facts.test.ts covering a bare-name
 *      and a "how do I" phrasing.
 */
export const PAGE_FACTS: Record<string, PageFact> = {
  dashboard: {
    domain: "dashboard",
    route: "/",
    title: "Dashboard",
    purpose: "Your morning landing page — a briefing of what matters across Instinct right now.",
    what_you_can_do: [
      "See your morning briefing with today's meetings, priority tasks, and flagged emails.",
      "Jump to any connected tool (calendar, meetings, clients, goals) from the quick nav.",
      "Spot new notifications, pending approvals, and items that need your attention today.",
      "Track which integrations (Microsoft 365, QuickBooks) are connected and healthy.",
    ],
    how_to: [
      "Sign in — the dashboard loads automatically as your home screen.",
      "Scan the briefing panel at the top for today's agenda.",
      "Click any summary card to drill into the underlying page (meetings, tasks, clients, etc.).",
    ],
    related_pages: ["calendar", "meetings", "tasks", "notifications"],
  },
  assistant: {
    domain: "assistant",
    route: "/assistant",
    title: "Assistant",
    purpose: "Your Wolfpack AI assistant — ask questions, get answers from your own data first, AI only when needed.",
    what_you_can_do: [
      "Ask about any Instinct page, client, meeting, document, or workflow in plain English.",
      "Get answers from the Knowledge Base, your Brain uploads, and meeting transcripts with zero AI tokens.",
      "Attach a file and have it ingested into the Brain for future questions.",
      "Review past conversations; rate answers to improve future results.",
      "Click the related-page chips under every answer to jump straight to the right place in Instinct.",
    ],
    how_to: [
      "Type your question in the chat box at the bottom.",
      "Review the answer and the chips beneath it — chips are direct links into Instinct.",
      "Rate the answer 1–5 stars so the system learns what was useful.",
    ],
    related_pages: ["knowledge", "brain", "meetings"],
  },
  calendar: {
    domain: "calendar",
    route: "/calendar",
    title: "Calendar",
    purpose: "Your Microsoft 365 calendar view inside Instinct — book meetings, check availability, and see weekly meeting-hour trends.",
    what_you_can_do: [
      "See every meeting on your Microsoft 365 calendar in day, week, or month view.",
      "Check your free time before scheduling, and suggest slots to teammates.",
      "Spot meeting-hour trends per week so you can protect focus time.",
      "See the contacts you meet with most often and jump straight to their profiles.",
      "Create a new meeting with prep notes that flow into the Meetings page.",
    ],
    how_to: [
      "Make sure Microsoft 365 is connected on the Settings page.",
      "Open Calendar and pick the day or week you want to review.",
      "Click any open slot to create a meeting, or click an existing event to edit it.",
    ],
    related_pages: ["meetings", "people", "settings"],
  },
  meetings: {
    domain: "meetings",
    /* First-tab landing — see related-pages.ts for the same fix.
       Sidebar nav uses /meetings/feeds; chatbot helpers should agree. */
    route: "/meetings/feeds",
    title: "Meetings",
    purpose: "The canonical home for every meeting — agendas, transcripts, decisions, and follow-ups — linked to calendar events.",
    what_you_can_do: [
      "Browse every past and upcoming meeting with title, attendees, and recording status.",
      "Read transcripts captured by Plaud and search across every meeting you've had.",
      "See decisions and action items extracted from each meeting.",
      "Open the source calendar event or jump to the attendees' profiles.",
      "File a meeting as a client interaction so it shows up on the client timeline.",
    ],
    how_to: [
      "Open Meetings from the left nav.",
      "Filter by date range, attendee, or client to narrow the list.",
      "Click a meeting to read its transcript, summary, and action items.",
    ],
    related_pages: ["calendar", "people", "clients"],
  },
  knowledge: {
    domain: "knowledge",
    route: "/knowledge",
    title: "Knowledge Base",
    purpose: "The team's shared Q&A — the first place the assistant looks when anyone asks a question.",
    what_you_can_do: [
      "Browse and search every answer the team has saved.",
      "Add a new entry (question + answer) so future askers get it at zero AI cost.",
      "Rate answers 1–5 stars so the assistant learns which entries to trust.",
      "Tag entries by topic so related questions surface the right answer.",
    ],
    how_to: [
      "Open Knowledge from the left nav.",
      "Search for your question — if you see a match, click to read it.",
      "If nothing matches, click Add entry and save the answer you already know.",
    ],
    related_pages: ["assistant", "brain", "docs"],
  },
  brain: {
    domain: "brain",
    route: "/brain",
    title: "Central Brain",
    purpose: "Upload company documents, playbooks, and SOPs — the assistant grounds answers in them before calling AI.",
    what_you_can_do: [
      "Upload PDFs, Word docs, or text files; they're chunked and indexed for retrieval.",
      "Search across every uploaded doc with keyword + semantic matching.",
      "See which docs the assistant cited for any given answer, and open them directly.",
      "Remove or re-index a document when it goes stale.",
    ],
    how_to: [
      "Open the Brain page and click Upload.",
      "Select a document; wait for it to finish ingesting.",
      "Ask the assistant a question — it will cite the Brain chunks it used.",
    ],
    related_pages: ["assistant", "knowledge", "docs"],
  },
  people: {
    domain: "people",
    route: "/people",
    title: "People",
    purpose: "Your unified contact list — teammates, clients, vendors — synced with Microsoft 365 and client records.",
    what_you_can_do: [
      "Search every contact by name, company, or email.",
      "See a contact's profile: recent meetings, emails, and linked client account.",
      "Add a new contact or edit an existing one; changes sync back to Microsoft 365.",
      "See presence status (online / busy / away) for teammates on Microsoft Teams.",
    ],
    how_to: [
      "Open People from the left nav.",
      "Search by name or company, or scroll the contact list.",
      "Click a contact to open their profile and see every interaction you've had.",
    ],
    related_pages: ["directory", "clients", "meetings"],
  },
  directory: {
    domain: "directory",
    route: "/directory",
    title: "Team Directory",
    purpose: "The internal team roster — who works with you, their role, and how to reach them.",
    what_you_can_do: [
      "Browse every teammate in your workspace with role, department, and contact info.",
      "See the reporting structure / org chart at a glance.",
      "Jump into a teammate's 1:1 notes, shared goals, or last meeting.",
      "Invite a new teammate and set their starting role and permissions.",
    ],
    how_to: [
      "Open Directory from the left nav.",
      "Filter by department, role, or search by name.",
      "Click a teammate to open their profile, or click Invite to add a new one.",
    ],
    related_pages: ["people", "hr", "admin"],
  },
  tasks: {
    domain: "tasks",
    route: "/tasks",
    title: "Tasks",
    purpose: "Your personal and shared task list — synced with Microsoft To Do and meeting-derived action items.",
    what_you_can_do: [
      "Capture to-dos with a due date, priority, and assignee.",
      "See tasks auto-created from meeting action items so nothing falls through the cracks.",
      "Check off completed tasks; they roll into your weekly report.",
      "Filter by due date, client, project, or teammate.",
    ],
    how_to: [
      "Open Tasks from the left nav.",
      "Click Add task, enter a title, and set a due date.",
      "Check the box when done — completion is logged for analytics.",
    ],
    related_pages: ["planner", "meetings", "goals"],
  },
  planner: {
    domain: "planner",
    route: "/planner",
    title: "Planner",
    purpose: "Your weekly plan — drag tasks and goals onto specific days so the week is intentional, not reactive.",
    what_you_can_do: [
      "View the week in one screen: each day's meetings, tasks, and goal checkpoints.",
      "Drag an open task onto a specific day to batch your week in one pass.",
      "See conflicts between meeting load and deep-work time, per day.",
      "Export the plan as a weekly briefing that lands on your Dashboard.",
    ],
    how_to: [
      "Open Planner on Monday morning (or whenever you plan).",
      "Review the week's meetings; drag tasks from the side panel onto the days you'll do them.",
      "Save — the plan becomes the basis of your daily briefing.",
    ],
    related_pages: ["tasks", "goals", "calendar"],
  },
  goals: {
    domain: "goals",
    route: "/goals",
    title: "Goals & OKRs",
    purpose: "Track company, team, and personal objectives with measurable key results (KRs) and weekly progress updates.",
    what_you_can_do: [
      "Create an objective with 2–5 KRs; each KR has a target and a current value.",
      "Update progress weekly; the chart shows on-track, at-risk, or off-track automatically.",
      "Link KRs to specific tasks or meetings so work ladders up to strategy.",
      "Review OKR health across the whole team in one dashboard.",
    ],
    how_to: [
      "Open Goals from the left nav.",
      "Click New objective, write the objective, and add 2–5 KRs with targets.",
      "Check in weekly and update each KR's current value — status updates automatically.",
    ],
    related_pages: ["tasks", "reports", "planner"],
  },
  journal: {
    domain: "journal",
    route: "/journal",
    title: "Journal",
    purpose: "A private daily note space — jot reflections, wins, blockers, and ideas; the assistant can recall them on demand.",
    what_you_can_do: [
      "Write a short daily entry — free text, no structure required.",
      "Tag entries by project, client, or mood to find patterns later.",
      "Search across every entry you've ever written.",
      "Let the assistant surface relevant past entries when you're facing a similar problem.",
    ],
    how_to: [
      "Open Journal from the left nav.",
      "Click New entry and write what's on your mind — no formatting required.",
      "Tag the entry, save it, and move on; the assistant will recall it when useful.",
    ],
    related_pages: ["assistant", "tasks", "reports"],
  },
  discussions: {
    domain: "discussions",
    route: "/discussions",
    title: "Discussions",
    purpose: "Threaded conversations for decisions, feedback, and team debates — searchable, tagged, and auditable.",
    what_you_can_do: [
      "Start a new thread on any topic; tag teammates to pull them in.",
      "Reply inline and keep the full back-and-forth in one place.",
      "Mark a thread resolved once a decision is made; the decision is captured for audit.",
      "Search every thread the team has ever had.",
    ],
    how_to: [
      "Open Discussions from the left nav.",
      "Click New thread, give it a title, and post the opening message.",
      "Tag the people you need input from; replies stay threaded under the original.",
    ],
    related_pages: ["meetings", "docs", "people"],
  },
  docs: {
    domain: "docs",
    route: "/docs",
    title: "Docs",
    purpose: "Generated and uploaded documents — proposals, reports, SOPs — produced by you or by the assistant.",
    what_you_can_do: [
      "Browse every document with title, type, and last-edited timestamp.",
      "Open a doc to edit, share, or export as PDF.",
      "Generate a new doc via the assistant (proposal, report, one-pager).",
      "Send a doc to Sites to publish it on a microsite.",
    ],
    how_to: [
      "Open Docs from the left nav.",
      "Click New doc or ask the assistant to draft one.",
      "Edit, share, or export — changes are versioned automatically.",
    ],
    related_pages: ["assistant", "sites", "knowledge"],
  },
  features: {
    domain: "features",
    route: "/features",
    title: "Feature Requests",
    purpose: "The backlog of ideas and automations the team wants built into Instinct — vote, comment, and track shipping.",
    what_you_can_do: [
      "Submit a new feature request with a description and priority.",
      "Upvote or comment on existing requests so the team sees what matters.",
      "See status: submitted, planned, in progress, shipped.",
      "Subscribe to a request so you're notified when it ships.",
    ],
    how_to: [
      "Open Features from the left nav.",
      "Search for your idea; if it exists, upvote it. If not, click Submit.",
      "Add a clear description and submit — the team reviews weekly.",
    ],
    related_pages: ["discussions", "reports", "admin"],
  },
  clients: {
    domain: "clients",
    route: "/clients",
    title: "Clients",
    purpose: "The single view of every client — projects, meetings, emails, financials, and documents in one place.",
    what_you_can_do: [
      "Browse every client account with status, owner, and last touch.",
      "Open a client to see the full timeline: meetings, emails, tasks, and docs.",
      "Log a new interaction or upload a client document.",
      "See revenue, margin, and outstanding invoices per client.",
    ],
    how_to: [
      "Open Clients from the left nav.",
      "Search by client name or filter by owner.",
      "Click into a client to see their timeline and add a new interaction.",
    ],
    related_pages: ["meetings", "emails", "financials"],
  },
  sites: {
    domain: "sites",
    route: "/sites",
    title: "Sites",
    purpose: "Branded microsites you generate for clients, campaigns, or internal pages — published with one click.",
    what_you_can_do: [
      "Create a new site from a brief; Instinct drafts the copy and sections.",
      "Edit the site in a split-screen prompt editor with live iframe preview.",
      "Publish to a Vercel domain; unpublish just as easily.",
      "Add sections (testimonials, pricing, FAQ) with one click.",
    ],
    how_to: [
      "Open Sites from the left nav and click New site.",
      "Describe the site in a short brief; review the draft preview.",
      "Adjust sections and theme, then click Publish to push it live.",
    ],
    related_pages: ["docs", "clients", "admin"],
  },
  hr: {
    domain: "hr",
    route: "/hr",
    title: "HR",
    purpose: "Headcount, benefits, onboarding, and payroll — every employee document and milestone in one place.",
    what_you_can_do: [
      "Manage the employee roster with start date, role, and status.",
      "Upload and route benefits, tax forms, and policy documents per employee.",
      "Run the onboarding checklist for new hires.",
      "See payroll status and costs across the company.",
    ],
    how_to: [
      "Open HR from the left nav.",
      "Filter by department or status, or search for an employee.",
      "Click an employee to open their profile, documents, and history.",
    ],
    related_pages: ["directory", "financials", "docs"],
  },
  financials: {
    domain: "financials",
    route: "/financials",
    title: "Financials",
    purpose: "Revenue, expenses, margin, and cash position — pulled live from QuickBooks and summarized per client and month.",
    what_you_can_do: [
      "See total revenue, expenses, and profit for any period.",
      "Drill into revenue per client or expense per category.",
      "Spot outstanding invoices and aged receivables.",
      "Track margin trends week over week and month over month.",
    ],
    how_to: [
      "Make sure QuickBooks is connected on the Settings page.",
      "Open Financials and pick the period you want to review.",
      "Click any number to drill into the underlying invoices, expenses, or clients.",
    ],
    related_pages: ["clients", "reports", "settings"],
  },
  emails: {
    domain: "emails",
    route: "/emails",
    title: "Emails",
    purpose: "Your Microsoft 365 inbox inside Instinct — triage, reply, and link messages to clients and projects.",
    what_you_can_do: [
      "Read your inbox with threading, attachments, and search.",
      "Reply, forward, or draft a new message; attachments work as expected.",
      "Link an email to a client account so it shows up on their timeline.",
      "Convert an email into a task with one click.",
    ],
    how_to: [
      "Make sure Microsoft 365 is connected on the Settings page.",
      "Open Emails from the left nav to see your inbox.",
      "Click a message to read; use Reply or Link to client from the action bar.",
    ],
    related_pages: ["clients", "tasks", "settings"],
  },
  mailbox: {
    domain: "mailbox",
    route: "/emails",
    title: "Mailbox",
    purpose: "Your Microsoft 365 mailbox inside Instinct — same page as Emails, just another word for it.",
    what_you_can_do: [
      "Read, reply to, and draft email from your Microsoft 365 account.",
      "Link any message to a client or project.",
      "Convert a message into a task or meeting.",
      "Search across every folder your Microsoft account exposes.",
    ],
    how_to: [
      "Make sure Microsoft 365 is connected on the Settings page.",
      "Open Emails (the mailbox) from the left nav.",
      "Read and act on messages exactly like you would in Outlook.",
    ],
    related_pages: ["clients", "tasks", "settings"],
  },
  reports: {
    domain: "reports",
    route: "/reports",
    title: "Reports",
    purpose: "Weekly and monthly reports summarizing activity across meetings, tasks, goals, and clients.",
    what_you_can_do: [
      "See your personal weekly report: meetings held, tasks completed, KRs moved.",
      "Generate a team report per week or month.",
      "Export a report as PDF or share a link with stakeholders.",
      "Let the assistant draft a narrative summary of the report for you.",
    ],
    how_to: [
      "Open Reports from the left nav.",
      "Pick the period (week or month) and scope (you or team).",
      "Review the auto-generated report; export or share as needed.",
    ],
    related_pages: ["analytics", "goals", "tasks"],
  },
  analytics: {
    domain: "analytics",
    route: "/analytics",
    title: "Analytics",
    purpose: "The metrics dashboard — event counts, usage trends, and the learning-loop feedback that shapes Instinct itself.",
    what_you_can_do: [
      "See top events from the last 7 days — meetings viewed, tasks completed, questions asked.",
      "Track adoption per page so you know what the team is actually using.",
      "Watch the learning loop: which assistant answers are rated up or down, and why.",
      "Spot week-over-week changes in activity for any event type.",
    ],
    how_to: [
      "Open Analytics from the left nav.",
      "Pick the time window you want (7d, 30d, or custom).",
      "Click any event row to see the underlying data.",
    ],
    related_pages: ["reports", "admin", "dashboard"],
  },
  notifications: {
    domain: "notifications",
    route: "/notifications",
    title: "Notifications",
    purpose: "Every alert Instinct raises for you — approvals, mentions, meeting invites, integration failures — in one place.",
    what_you_can_do: [
      "See unread alerts grouped by type: mentions, approvals, system.",
      "Mark individual items read, or clear the full list.",
      "Click any alert to jump straight to the page it's about.",
      "Tune which notifications you receive in Settings.",
    ],
    how_to: [
      "Click the bell icon in the top bar, or open Notifications from the left nav.",
      "Read an alert and click it to act on it.",
      "Open Settings → Notifications to customize which alerts reach you.",
    ],
    related_pages: ["settings", "dashboard", "admin"],
  },
  settings: {
    domain: "settings",
    route: "/settings",
    title: "Settings",
    purpose: "Connect integrations (Microsoft 365, QuickBooks), manage your profile, and tune preferences.",
    what_you_can_do: [
      "Connect or disconnect Microsoft 365, QuickBooks, Plaud, and other integrations.",
      "Update your profile: name, role, avatar, and time zone.",
      "Set notification preferences — which events ping you and which stay silent.",
      "Review the integration health panel to spot stale or failed connections.",
    ],
    how_to: [
      "Open Settings from the left nav (or the gear icon in the top bar).",
      "Pick the Integrations tab and click Connect next to the service you want.",
      "Follow the OAuth flow; you'll return to Settings with the service connected.",
    ],
    related_pages: ["admin", "notifications", "dashboard"],
  },
  admin: {
    domain: "admin",
    route: "/admin/audit",
    title: "Admin",
    purpose: "Workspace administration — audit logs, user management, and system-wide controls for admins only.",
    what_you_can_do: [
      "Review the audit log: every security-sensitive action, timestamped and attributed.",
      "Manage users: invite, remove, or change a teammate's role.",
      "Review and approve pending access requests.",
      "Configure workspace-wide security policies and data-retention rules.",
    ],
    how_to: [
      "Make sure your role is admin (non-admins can't see this page).",
      "Open Admin from the left nav.",
      "Pick the tab you need: Audit, Users, or Policies.",
    ],
    related_pages: ["settings", "directory", "analytics"],
  },
  tools: {
    domain: "tools",
    route: "/tools",
    title: "Tools",
    purpose: "One-click utilities built into Instinct — run browser probes, trigger Vibium smoke tests, and invoke the zero-token scanner suite without leaving the app.",
    what_you_can_do: [
      "Run a browser probe against any allowlisted domain and see the result inline.",
      "Invoke the Instinct scanner suite against the current workspace.",
      "Trigger a Vibium smoke test for any connected integration.",
      "View recent tool runs + their outcomes in the history panel.",
    ],
    how_to: [
      "Open Tools from the left nav.",
      "Pick the tool you want (Browser Probe, Scanner, Smoke Test).",
      "Fill in the target, click Run, and review the result in the output panel.",
    ],
    related_pages: ["admin", "analytics", "dashboard"],
  },
  automations: {
    domain: "automations",
    route: "/automations",
    title: "Automations",
    purpose: "Codified recurring workflows — Instinct watches an inbox, parses inbound artifacts, surfaces deltas vs. the previous snapshot, and queues anything ambiguous for human review. The first registered automation is Porsche BA101/102 registration ingest.",
    what_you_can_do: [
      "See every registered automation and its owner at /automations.",
      "Open an automation to view artifacts received today, classes in window, and open exceptions.",
      "Click Changes to see a Mon/Fri-style digest of who joined / dropped per class.",
      "Resolve or dismiss exceptions (parse failures, low-confidence matches) from the queue.",
      "Click Run now to trigger an ad-hoc inbox poll.",
    ],
    how_to: [
      "Open Automations from the left nav.",
      "Click into a specific automation (e.g. Porsche BA101/102).",
      "Use the metric tiles to gauge state, then drill into Changes or Exceptions.",
    ],
    related_pages: ["dashboard", "analytics", "knowledge"],
  },
  messages: {
    domain: "messages",
    route: "/messages",
    title: "Messages",
    purpose: "Your Microsoft Teams 1:1 chats inside Instinct — read recent threads without flipping to the Teams desktop app; reply, call, or video-call via one-click Teams deep-links.",
    what_you_can_do: [
      "See your recent 1:1 Teams chats sorted by latest activity.",
      "Read the full message thread inside Instinct — no more tab-flipping.",
      "Click Reply in Teams to open the Teams compose window pre-loaded with the chat.",
      "Click Call or Video call to start a Teams call with the recipient — no calendar step needed.",
    ],
    how_to: [
      "Make sure Microsoft 365 is connected on the Settings page and you have granted Chat.Read + Presence.Read.",
      "Open Messages from the left nav.",
      "Pick a chat on the left to see the thread; use the action bar to reply or call.",
    ],
    related_pages: ["people", "calendar", "settings"],
  },
  setup: {
    domain: "setup",
    route: "/setup",
    title: "Setup",
    purpose: "First-run workspace setup — connect Microsoft 365, invite teammates, and provision the defaults that let Instinct work for your org.",
    what_you_can_do: [
      "Connect your Microsoft 365 workspace so the assistant can read your calendar, mail, and people.",
      "Invite teammates and assign starter roles.",
      "Pick which optional integrations your team needs (QuickBooks, Teams meetings, etc).",
      "Review a quick walkthrough of where key pages live.",
    ],
    how_to: [
      "Open Setup from the left nav (new workspaces see it at the top).",
      "Work through the stages in order — each one saves as you go.",
      "Come back any time to re-run a step you skipped.",
    ],
    related_pages: ["settings", "directory", "dashboard"],
  },
  bulletin: {
    domain: "bulletin",
    route: "/bulletin",
    title: "Bulletin",
    purpose: "Shared sticky-note boards — quick visual coordination for the team without a meeting.",
    what_you_can_do: [
      "Spin up a new board for any topic and share it with the team.",
      "Drop sticky notes anywhere on the canvas — drag to rearrange.",
      "Group notes by color, archive boards once a project wraps.",
      "Open older boards from the Archived section when you need to look something up.",
    ],
    how_to: [
      "Click Create new board, name it, and pick a color.",
      "Drag notes onto the canvas — text edits inline.",
      "Archive the board from its menu when the conversation is done.",
    ],
    related_pages: ["discussions", "messages", "tasks"],
  },
  principles: {
    domain: "principles",
    route: "/principles",
    title: "Principles",
    purpose: "Operating principles dashboard — track how the team is living the values, both for self-improvement and team alignment.",
    what_you_can_do: [
      "Read each principle in plain English with examples of what it looks like in practice.",
      "Log your own observations against a principle to track your own growth.",
      "(Leads only) See team-wide aggregates and per-member evidence.",
    ],
    how_to: [
      "Open Principles from the left nav.",
      "Pick a principle to read the explainer and example log entries.",
      "Click Add observation to log how you applied it.",
    ],
    related_pages: ["goals", "people", "journal"],
  },
  programs: {
    domain: "programs",
    route: "/programs/budgets",
    title: "Programs",
    purpose: "Cross-team programs — multi-month initiatives that need a budget, owners, and tracked milestones.",
    what_you_can_do: [
      "See every active program with its current spend vs budget.",
      "Drill into a program to see owners, milestones, and the budget breakdown.",
      "Spot programs trending over budget before quarter end.",
    ],
    how_to: [
      "Open Programs → Budgets from the left nav.",
      "Click any program to see its full plan.",
      "Use the filter at the top to focus on one team or one budget cycle.",
    ],
    related_pages: ["financials", "goals", "reports"],
  },
  qr: {
    domain: "qr",
    route: "/qr",
    title: "QR Generator",
    purpose: "Mint short-link QR codes the team can print on physical assets, then track scans per code.",
    what_you_can_do: [
      "Generate a QR code from a slug and a destination URL.",
      "Edit the destination later without reprinting — the slug stays the same.",
      "View scan counts per code so you know which printed assets are working.",
      "Export the QR image in PNG / SVG / PDF / EPS for print.",
    ],
    how_to: [
      "Open QR Generator from the left nav.",
      "Enter a memorable slug and the URL you want it to point to.",
      "Download the QR image in the format your printer expects.",
    ],
    related_pages: ["sites", "analytics", "messages"],
  },
  surveys: {
    domain: "surveys",
    route: "/surveys",
    title: "Surveys",
    purpose: "Build short surveys in-house, publish them to a public link, and read the aggregated results.",
    what_you_can_do: [
      "Build a survey from a handful of question types (single choice, multiple choice, rating, short text, long text).",
      "Publish each survey to a public responder link so anyone can answer without signing in.",
      "Link a QR code to a published survey so a printed asset points straight at it.",
      "Read aggregated results per survey to see how people responded.",
    ],
    how_to: [
      "Open Surveys from the left nav.",
      "Add your questions, pick a type for each, and mark the required ones.",
      "Publish the survey, then share the public link or its QR code.",
    ],
    related_pages: ["sites", "analytics", "messages"],
  },
  search: {
    domain: "search",
    route: "/search",
    title: "Search",
    purpose: "Universal search across every Instinct surface — chats, channels, emails, calendar, and the knowledge base.",
    what_you_can_do: [
      "Type a query once and see results grouped by chats, channels, emails, calendar, and knowledge.",
      "Narrow by type with the filter chips at the top.",
      "Open any result directly into its source surface — link state is shareable.",
    ],
    how_to: [
      "Open Search from the left nav.",
      "Type a query — results stream in as you type.",
      "Click a filter chip to narrow to one source.",
    ],
    related_pages: ["knowledge", "emails", "calendar"],
  },
  support: {
    domain: "support",
    route: "/support",
    title: "Support",
    purpose: "Internal support ticket list — every ticket the operator has access to, filterable by status.",
    what_you_can_do: [
      "See all open / closed / pending tickets in one view.",
      "Filter by status with the pill row at the top.",
      "Click into any ticket to see the conversation and update its status.",
    ],
    how_to: [
      "Open Support from the left nav.",
      "Pick a status filter to focus the list.",
      "Click a row to open the ticket detail.",
    ],
    related_pages: ["messages", "notifications", "people"],
  },
  "job-codes": {
    domain: "job-codes",
    route: "/job-codes",
    title: "Job Codes",
    purpose: "Read-only view of the Wolfpack job codes synced live from SharePoint.",
    what_you_can_do: [
      "Look up the canonical job code for any active project or program.",
      "Click into a code to see its description and the team that owns it.",
      "Confirm a code is still active before billing or logging time against it.",
    ],
    how_to: [
      "Open Job Codes from the left nav.",
      "Search or scroll to the code you need.",
      "Click the row for the full description and ownership.",
    ],
    related_pages: ["time", "financials", "clients"],
  },
  time: {
    domain: "time",
    route: "/time",
    title: "My Time",
    purpose: "Personal time tracking — log hours against the Wolfpack job codes you're working on.",
    what_you_can_do: [
      "Add a time entry for any job code with hours, date, and a short note.",
      "Review your recent entries and edit or delete any that need adjustment.",
      "See running totals so you know where your time went this week.",
    ],
    how_to: [
      "Open My Time from the left nav.",
      "Pick a job code, enter hours and date, click Add.",
      "Check the Entries list to confirm the entry landed.",
    ],
    related_pages: ["job-codes", "reports", "tasks"],
  },
  "finance-invoices": {
    domain: "finance-invoices",
    route: "/finance/invoices",
    title: "Invoices",
    purpose: "AP invoice queue — upload incoming invoices, review the extracted fields, approve, and mark paid.",
    what_you_can_do: [
      "Upload an invoice PDF and let the extractor pull vendor, amount, and due date.",
      "Review the extracted fields and correct anything the extractor got wrong.",
      "Route the invoice for approval, then mark it paid once payment is sent.",
      "Filter the queue by status to focus on what needs attention.",
    ],
    how_to: [
      "Open Finance → Invoices from the left nav.",
      "Drop a PDF onto the upload area or click Upload.",
      "Review the extracted fields, approve, and mark paid when settled.",
    ],
    related_pages: ["financials", "clients", "reports"],
  },
  "portal-salesforce": {
    domain: "portal-salesforce",
    route: "/portal/salesforce",
    title: "Salesforce Portal",
    purpose: "Read your Salesforce accounts, contacts, and opportunities inside Instinct — no tab-switching to Salesforce.",
    what_you_can_do: [
      "Browse Accounts, Contacts, and Opportunities pulled live from Salesforce.",
      "Open any record to see the full detail page Salesforce would show.",
      "Search across object types from one entry point.",
    ],
    how_to: [
      "Open Portal → Salesforce from the left nav.",
      "Pick an object type (accounts / contacts / opportunities) from the pills.",
      "Search or click a row to drill in.",
    ],
    related_pages: ["clients", "people", "settings"],
  },
};

/** Alphabetical list of every known domain key. Stable across runs. */
export const PAGE_FACT_DOMAINS: string[] = Object.keys(PAGE_FACTS).sort();

/**
 * Format a PageFact as markdown. Always embeds the route as a markdown
 * link so `detectRelatedPagesFromExchange` picks up the route when it
 * scans the response text — chips render for free, no payload field
 * needed. Related-page chips are rendered inline with `/route` syntax
 * so the same detector picks them up too.
 */
export function formatPageFactsAnswer(fact: PageFact): string {
  const lines: string[] = [];
  lines.push(`**${fact.title}** — ${fact.purpose}`);
  lines.push("");
  lines.push("**What you can do**");
  for (const bullet of fact.what_you_can_do) {
    lines.push(`- ${bullet}`);
  }
  lines.push("");
  lines.push("**How to use it**");
  fact.how_to.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push("");

  const relatedLinks = fact.related_pages
    .map((d) => {
      const other = PAGE_FACTS[d];
      if (!other) return null;
      return `[${other.title}](${other.route})`;
    })
    .filter((s): s is string => !!s);

  const openLink = `Open it: [${fact.title}](${fact.route})`;
  const relatedLine =
    relatedLinks.length > 0 ? ` · Related: ${relatedLinks.join(" · ")}` : "";
  lines.push(openLink + relatedLine);

  return lines.join("\n");
}
