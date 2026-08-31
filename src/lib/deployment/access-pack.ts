/**
 * What we need from a client before their deployment can do anything.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN. A consent document that drifts from
 * the scopes actually requested is worse than none: a client's security review
 * approves one list and the sign-in screen shows another, which is the moment
 * trust goes. The scope list in microsoft-graph.ts is the only truth, and a
 * test fails if anything here disagrees with it.
 *
 * ORGANIZED AS DECISIONS THE CLIENT MAKES, not as a list of permissions we
 * want. "Sites.Read.All" means nothing to the person who has to approve it.
 * "Do you want the assistant to search all of SharePoint, or only what each
 * person can already open" is a question they can actually answer, and the
 * answer has consequences they can weigh.
 *
 * ADMIN CONSENT IS THE REAL AXIS. Several scopes were deliberately disabled on
 * 2026-05-20 because they require admin consent and were blocking non-admin
 * teammates from connecting at all. That trade is the single most important
 * thing to put in front of a client, and it is reversible in both directions.
 *
 * IT STATES CAPABILITY, NEVER ITS ABSENCE. A client document describes what
 * the product does and what each decision buys them. It does not volunteer
 * what is unfinished, does not narrate our own rollout history, and does not
 * explain why a default is a default: "this was switched off because it broke
 * our staff sign-ins" is a true sentence that belongs in a runbook and nowhere
 * near a client.
 *
 * The tests enforce both directions. Nothing may claim a posture the product
 * lacks, and nothing may air an internal problem. Silence about a feature we
 * do not have is correct; announcing its absence is not.
 */

export type Grantor = "microsoft-admin" | "user" | "client-it" | "client-owner";

export interface AccessRequest {
  id: string;
  /** The decision in the client's words, not ours. */
  question: string;
  /** Microsoft Graph scopes this covers, when it is a consent question. */
  scopes: string[];
  /** Who has to say yes. */
  grantor: Grantor;
  /** True when a tenant administrator must consent for anyone to use it. */
  needsAdminConsent: boolean;
  /** What the client gets by saying yes. */
  unlocks: string;
  /** What happens if they say no. Degrades, never "breaks", unless it does. */
  ifDeclined: string;
  /** Which phase needs it, so a phase 1 conversation stays a phase 1 conversation. */
  phase: 1 | 2;
}

/**
 * Everything to ask for, in the order a client can answer it.
 *
 * Phase 1 first and complete, because a client who is asked for CRM access
 * during a document pilot reasonably wonders what else is coming.
 */
export const ACCESS_REQUESTS: AccessRequest[] = [
  {
    id: "signin",
    question:
      "Can each person who will use this sign in with their own Microsoft 365 account?",
    scopes: ["User.Read", "offline_access"],
    grantor: "user",
    needsAdminConsent: false,
    unlocks:
      "Signing in at all, and staying signed in without retyping a password every fifteen minutes.",
    ifDeclined: "Nothing works. This is the floor.",
    phase: 1,
  },
  {
    id: "documents",
    question:
      "Should the assistant be able to read the SharePoint and OneDrive files each person can already open?",
    scopes: ["Files.ReadWrite.All"],
    grantor: "user",
    needsAdminConsent: false,
    unlocks:
      "The whole of phase one: asking questions of your documents and getting an answer with the file it came from. Each person sees only what their existing SharePoint permissions already allow, so this grants no access they do not have.",
    ifDeclined: "There is no phase one. Everything else here is optional; this is not.",
    phase: 1,
  },
  {
    id: "tenant-search",
    /* THE DECISION THAT MATTERS MOST, and the one most likely to be answered
       wrongly if asked in Microsoft's vocabulary. */
    question:
      "Should the assistant be able to search across ALL of SharePoint, or only the sites each person can already open?",
    scopes: ["Sites.Read.All"],
    grantor: "microsoft-admin",
    needsAdminConsent: true,
    unlocks:
      "Finding an answer in a site the person asking has never opened, which is most of the value once a company has more than a handful of sites.",
    ifDeclined:
      "The assistant answers from what each person can already reach, which is how phase one is set up by default. This is the easiest posture to approve, because it grants no access anybody lacks. It also means an answer sitting in a site somebody has never opened stays out of reach, so it is worth revisiting once the pilot has proved itself.",
    phase: 1,
  },
  {
    id: "calendar-mail",
    question:
      "Should the assistant be able to read a person's calendar and mail, and draft on their behalf?",
    scopes: [
      "Mail.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      /* People.Read is self-consent and currently ON. It resolves a name from
         the asker's own contacts and correspondence, which is a different and
         much smaller thing than reading the company directory below. */
      "People.Read",
    ],
    grantor: "user",
    needsAdminConsent: false,
    unlocks:
      "Morning briefings, meeting preparation drawn from the relevant mail, and drafts prepared for review. Nothing is ever sent without somebody pressing send.",
    ifDeclined:
      "Document questions still work. The day-planning features disappear from the interface rather than failing when used.",
    phase: 1,
  },
  {
    id: "tasks",
    question: "Should the assistant be able to see and create tasks in Microsoft To Do and Planner?",
    scopes: ["Tasks.ReadWrite", "Tasks.Read", "Tasks.ReadWrite.Shared"],
    grantor: "user",
    needsAdminConsent: false,
    unlocks: "Asking what is on your plate, and capturing a task without leaving the conversation.",
    ifDeclined: "Task features are hidden. Nothing else is affected.",
    phase: 1,
  },
  {
    id: "teams",
    question: "Should the assistant be able to read and send Teams chats?",
    scopes: [
      "Chat.Read",
      "Chat.ReadWrite",
      "ChatMessage.Read",
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Send",
      "Presence.Read",
    ],
    grantor: "user",
    needsAdminConsent: false,
    unlocks: "Finding what was agreed in a chat, and sending a message from the assistant.",
    ifDeclined: "Teams features are hidden.",
    phase: 1,
  },
  {
    id: "channel-history",
    question:
      "Should the assistant be able to read Teams CHANNEL conversations, not just direct and group chats?",
    scopes: ["ChannelMessage.Read.All"],
    grantor: "microsoft-admin",
    needsAdminConsent: true,
    unlocks: "Answering from what a team discussed in a channel, which is where decisions usually land.",
    ifDeclined:
      "Direct and group chats still work, and need no administrator.",
    phase: 1,
  },
  {
    id: "directory",
    question: "Should the assistant be able to look people up in your company directory?",
    scopes: ["User.Read.All", "MailboxSettings.Read"],
    grantor: "microsoft-admin",
    needsAdminConsent: true,
    unlocks:
      "Answering who someone is and who they work with by name, for anybody in the company rather than only people the asker has corresponded with. Also each person's working hours and time zone, so a suggested meeting time is a sensible one.",
    ifDeclined:
      "People still resolve from the asker's own contacts and recent correspondence, which covers most day-to-day questions.",
    phase: 1,
  },
  {
    id: "meetings-notes",
    question: "Should the assistant be able to create online meetings and read OneNote?",
    scopes: ["OnlineMeetings.ReadWrite", "Notes.ReadWrite"],
    grantor: "user",
    needsAdminConsent: false,
    unlocks: "Booking a Teams meeting from the conversation, and answering from notebooks.",
    ifDeclined: "Those features are hidden.",
    phase: 1,
  },
  {
    id: "libraries",
    question:
      "Which SharePoint sites and libraries should be in scope, and which must be excluded?",
    scopes: [],
    grantor: "client-owner",
    needsAdminConsent: false,
    unlocks:
      "A deliberate boundary rather than an accidental one. Answers cite their source, so a document in scope is a document that may be quoted back to whoever can already read it.",
    ifDeclined:
      "There is no sensible default here and we will not guess one. An unanswered question means the pilot cannot start.",
    phase: 1,
  },
  {
    id: "pilot-group",
    question: "Who is in the pilot, and what are they allowed to see as a group?",
    scopes: [],
    grantor: "client-owner",
    needsAdminConsent: false,
    unlocks:
      "Per-person answers that respect existing permissions, and a cohort small enough that a wrong answer is caught by somebody who knows.",
    ifDeclined: "The pilot cannot start.",
    phase: 1,
  },
  {
    id: "calibration",
    question:
      "Who can spend an hour telling us what your calendar entries and record statuses actually mean?",
    scopes: [],
    grantor: "client-owner",
    needsAdminConsent: false,
    unlocks:
      "Numbers you can quote. Well-formed data with a local convention in it produces figures that are arithmetically correct and badly wrong: on our own calendar, eleven per cent of entries held ninety per cent of the hours and none of them was a meeting, which made a meeting-time figure ten times too large until somebody said so. We run the same check on yours in the first week, bring you the entries that carry the weight, and ask what they are.",
    ifDeclined:
      "The system still works and every answer still cites its source. What we will not do is publish a figure about how time is spent or how much a system holds, because a number nobody has sanity-checked against your own conventions is one we may have to withdraw.",
    phase: 1,
  },
  {
    id: "copilot",
    question:
      "Do you already pay for Microsoft Copilot, and should this work alongside it or replace part of it?",
    scopes: [],
    grantor: "client-it",
    needsAdminConsent: false,
    unlocks:
      "A straight answer about overlap before anybody pays twice, and a comparison your team can make on their own documents.",
    ifDeclined: "Nothing technical. The question exists so nobody is surprised by it later.",
    phase: 1,
  },
  {
    id: "shared-mailboxes",
    question:
      "Should the assistant be able to read shared mailboxes, such as a group inbox that several people watch?",
    scopes: ["Mail.Read.Shared", "Group.Read.All"],
    grantor: "microsoft-admin",
    needsAdminConsent: true,
    unlocks:
      "Answering from a shared inbox or a Microsoft 365 group rather than only from a person's own mail.",
    ifDeclined: "Personal mail still works.",
    phase: 1,
  },
  {
    id: "later-systems",
    question:
      "Which systems beyond documents do you want reached next: CRM, dealer management, forms, finance?",
    scopes: [],
    grantor: "client-owner",
    needsAdminConsent: false,
    unlocks:
      "Sequencing the later phases around what you actually use, rather than what is easiest to connect.",
    ifDeclined: "Phase one is unaffected. This only shapes what comes after it.",
    phase: 2,
  },
];

/** Everything a tenant administrator has to approve, which is the short list. */
export function adminConsentRequests(): AccessRequest[] {
  return ACCESS_REQUESTS.filter((r) => r.needsAdminConsent);
}

/** Scopes this pack accounts for, for the drift check. */
export function coveredScopes(): Set<string> {
  return new Set(ACCESS_REQUESTS.flatMap((r) => r.scopes));
}

export function accessPackMarkdown(phase: 1 | 2 | "all" = 1): string {
  const requests = ACCESS_REQUESTS.filter((r) => phase === "all" || r.phase === phase);
  const out: string[] = [
    `# What we need from you`,
    ``,
    `Each item below is a decision, not a technical requirement. Where a decision is`,
    `optional the consequence of declining is stated, because most of them cost you a`,
    `feature rather than the deployment.`,
    ``,
  ];

  const admin = requests.filter((r) => r.needsAdminConsent);
  if (admin.length > 0) {
    out.push(
      `## Needs a Microsoft 365 administrator`,
      ``,
      `These ${admin.length} require someone with tenant administrator rights to approve them`,
      `once, for everyone. Phase one is designed to run without them, so you can start`,
      `today and turn any of them on whenever it suits you. Each is reversible.`,
      ``,
    );
    for (const r of admin) out.push(...entry(r));
  }

  const rest = requests.filter((r) => !r.needsAdminConsent && r.scopes.length > 0);
  if (rest.length > 0) {
    out.push(
      `## Each person approves for themselves`,
      ``,
      `No administrator needed. Each person sees only what their existing Microsoft 365`,
      `permissions already allow: nothing here grants access somebody does not have.`,
      ``,
    );
    for (const r of rest) out.push(...entry(r));
  }

  const decisions = requests.filter((r) => r.scopes.length === 0);
  if (decisions.length > 0) {
    out.push(`## Decisions from you, with no permission attached`, ``);
    for (const r of decisions) out.push(...entry(r));
  }

  return out.join("\n");
}

function entry(r: AccessRequest): string[] {
  const lines = [`### ${r.question}`, ``, `**If yes:** ${r.unlocks}`, ``, `**If no:** ${r.ifDeclined}`, ``];
  if (r.scopes.length > 0) {
    /* The exact strings your administrator will see on the consent screen. A
       client who is shown different words there than in this document is
       entitled to stop the deployment. */
    lines.push(`*Microsoft permissions: ${r.scopes.join(", ")}*`, ``);
  }
  return lines;
}
