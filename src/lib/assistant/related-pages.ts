/**
 * Related pages — zero-token keyword → Instinct route map.
 *
 * Detects which in-app domains a user's question touches and surfaces
 * them as chip-links below the assistant answer. Pure keyword match;
 * no LLM calls. Every link the UI renders fires
 * `assistant.link_clicked` with `{ domain }` so the learning loop can
 * see which related-page chips actually convert into navigation.
 *
 * The map is intentionally conservative — multiple keywords can map to
 * the same page (e.g. "contacts" + "people" → /people), and we dedupe
 * by href so a single answer never renders the same chip twice.
 */

export interface RelatedPage {
  /** Domain key (used in analytics metadata). */
  domain: string;
  /** Human label rendered on the chip. */
  label: string;
  /** Absolute route inside the Instinct app. */
  href: string;
}

/**
 * Each entry: keywords that imply the domain → (label, href).
 * Keep keywords lowercased; we match against the lowercased question.
 * Word-boundary semantics: we match on substring + surround-by-non-
 * word-char so "people" doesn't fire on "peopled". See
 * `matchesKeyword()` below.
 */
interface DomainEntry {
  domain: string;
  label: string;
  href: string;
  keywords: string[];
}

const DOMAIN_MAP: DomainEntry[] = [
  {
    domain: "calendar",
    label: "Calendar",
    href: "/calendar",
    keywords: ["calendar", "schedule", "availability", "meeting time", "free time"],
  },
  {
    domain: "meetings",
    label: "Meetings",
    href: "/meetings",
    keywords: ["meeting", "meetings", "standup", "huddle", "sync", "1:1", "1on1", "call"],
  },
  {
    domain: "people",
    label: "People",
    href: "/people",
    keywords: ["contact", "contacts", "person", "people", "teammate", "colleague"],
  },
  {
    domain: "tasks",
    label: "Tasks",
    href: "/tasks",
    keywords: ["task", "tasks", "todo", "to-do", "to do", "action item"],
  },
  {
    domain: "goals",
    label: "Goals & OKRs",
    href: "/goals",
    keywords: ["goal", "goals", "okr", "okrs", "kr", "key result", "north star"],
  },
  {
    domain: "discussions",
    label: "Discussions",
    href: "/discussions",
    keywords: ["discussion", "discussions", "thread", "threads"],
  },
  {
    domain: "docs",
    label: "Docs",
    href: "/docs",
    keywords: ["doc", "docs", "document", "documents", "generated doc"],
  },
  {
    domain: "knowledge",
    label: "Knowledge Base",
    href: "/knowledge",
    keywords: ["knowledge base", "knowledge", "kb", "wiki"],
  },
  {
    domain: "features",
    label: "Feature Requests",
    href: "/features",
    keywords: ["feature request", "feature", "features", "roadmap", "automation"],
  },
  {
    domain: "clients",
    label: "Clients",
    href: "/clients",
    keywords: ["client", "clients", "customer account", "account manager"],
  },
  {
    domain: "hr",
    label: "HR",
    href: "/hr",
    keywords: [
      "hr",
      "employee",
      "employees",
      "benefit",
      "benefits",
      "onboarding",
      "payroll",
      "headcount",
    ],
  },
  {
    domain: "journal",
    label: "Journal",
    href: "/journal",
    keywords: ["journal", "journal entry", "daily note"],
  },
  {
    domain: "sites",
    label: "Sites",
    href: "/sites",
    keywords: ["site", "sites", "website", "microsite", "landing page"],
  },
  {
    domain: "brain",
    label: "Brain",
    href: "/brain",
    keywords: ["brain", "uploaded doc", "uploaded docs", "company doc", "company docs"],
  },
  {
    domain: "financials",
    label: "Financials",
    href: "/financials",
    keywords: ["financial", "financials", "revenue", "expense", "expenses", "p&l", "profit", "margin"],
  },
  {
    domain: "emails",
    label: "Emails",
    href: "/emails",
    keywords: ["email", "emails", "inbox", "mail", "mailbox"],
  },
  {
    domain: "settings",
    label: "Settings",
    href: "/settings",
    keywords: [
      "settings",
      "setting",
      "integrations",
      "integration",
      "connect microsoft",
      "connect quickbooks",
      "disconnect",
      "preferences",
    ],
  },
  {
    domain: "admin",
    label: "Admin",
    href: "/admin",
    keywords: ["admin", "admin panel", "workspace admin"],
  },
  {
    domain: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    keywords: ["dashboard", "morning briefing", "briefing", "home screen"],
  },
  {
    domain: "notifications",
    label: "Notifications",
    href: "/notifications",
    keywords: ["notification", "notifications", "alerts", "alert"],
  },
  {
    domain: "planner",
    label: "Planner",
    href: "/planner",
    keywords: ["planner", "weekly plan", "week plan"],
  },
  {
    domain: "reports",
    label: "Reports",
    href: "/reports",
    keywords: ["report", "reports", "weekly report"],
  },
  {
    domain: "analytics",
    label: "Analytics",
    href: "/analytics",
    keywords: ["analytics", "metrics dashboard", "learning loop"],
  },
  {
    domain: "directory",
    label: "Directory",
    href: "/directory",
    keywords: ["directory", "team directory", "org chart"],
  },
];

/**
 * True when `keyword` appears as a whole-token fragment inside `text`.
 * Both are assumed lowercased. "task" matches "task list" but NOT
 * "tasksquad"; multi-word keywords match straight substrings so
 * "key result" fires even when the rest of the sentence wraps around.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    return text.includes(keyword);
  }
  // Single-word keyword → require non-alnum boundary on each side so
  // we don't fire on "emailserver" when the user typed "emails".
  const idx = text.indexOf(keyword);
  if (idx === -1) return false;
  const left = idx === 0 ? " " : text[idx - 1];
  const rightIdx = idx + keyword.length;
  const right = rightIdx >= text.length ? " " : text[rightIdx];
  const isWordChar = (c: string) => /[a-z0-9]/.test(c);
  return !isWordChar(left) && !isWordChar(right);
}

/**
 * Return the list of Instinct pages the user's question touches, in
 * the order they appear in DOMAIN_MAP. Returns [] on no match.
 *
 * Pure function. Safe to call from server-side route handlers AND
 * client components (no DB, no network).
 */
export function detectRelatedPages(question: string): RelatedPage[] {
  if (!question) return [];
  const lower = question.toLowerCase();
  const hits: RelatedPage[] = [];
  const seen = new Set<string>();
  for (const entry of DOMAIN_MAP) {
    if (seen.has(entry.href)) continue;
    if (entry.keywords.some((kw) => matchesKeyword(lower, kw))) {
      hits.push({ domain: entry.domain, label: entry.label, href: entry.href });
      seen.add(entry.href);
    }
  }
  return hits;
}

/**
 * Same as detectRelatedPages, but unions the hits from the user's
 * question AND the assistant's response text. The response is the
 * richer signal: it often names the exact page the user needs ("go to
 * Settings", "open the Integrations panel"), even when the user's
 * question didn't mention the page by name.
 */
export function detectRelatedPagesFromExchange(
  question: string,
  responseText: string,
): RelatedPage[] {
  const fromQuestion = detectRelatedPages(question);
  const fromResponse = detectRelatedPages(responseText);
  const seen = new Set<string>();
  const merged: RelatedPage[] = [];
  // Response first — when the assistant literally names the page,
  // that's the highest-signal chip, so it leads the row.
  for (const p of fromResponse) {
    if (seen.has(p.href)) continue;
    merged.push(p);
    seen.add(p.href);
  }
  for (const p of fromQuestion) {
    if (seen.has(p.href)) continue;
    merged.push(p);
    seen.add(p.href);
  }
  return merged;
}

/**
 * Map an intent-router intent string to the "From ..." attribution
 * line rendered beneath a tool answer. The intent is the ONLY signal
 * — we never surface raw tool data in the attribution.
 */
export function sourceLabelForIntent(intent: string): string {
  switch (intent) {
    case "calendar_availability":
    case "calendar_schedule":
      return "From Microsoft 365 · your calendar";
    case "mail_search":
      return "From Microsoft 365 · your mailbox";
    case "goals_lookup":
      return "From Instinct · Goals";
    case "financials_metric":
      return "From Instinct · Financials";
    case "brain_history":
      return "From Instinct · Brain (ingested docs)";
    default:
      return "From Instinct";
  }
}
