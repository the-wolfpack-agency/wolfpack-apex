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
    /* Land on the first tab (Email feeds) — same as the sidebar Nav.
       Was /meetings (the Plaud transcripts tab); users were dropping
       into the second tab without context for why they were there. */
    href: "/meetings/feeds",
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
    href: "/admin/audit",
    keywords: ["admin", "admin panel", "workspace admin", "audit log"],
  },
  {
    domain: "dashboard",
    label: "Dashboard",
    href: "/",
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
  {
    domain: "tools",
    label: "Tools",
    href: "/tools",
    keywords: ["tools", "utility", "utilities", "browser probe", "smoke test"],
  },
  {
    domain: "setup",
    label: "Setup",
    href: "/setup",
    keywords: ["setup", "set up", "first run", "workspace setup", "onboarding wizard"],
  },
  {
    domain: "messages",
    label: "Messages",
    href: "/messages",
    keywords: [
      "messages",
      "teams chat",
      "teams chats",
      "teams message",
      "teams messages",
      "1:1 chat",
      "chat thread",
      "direct message",
    ],
  },
];

/**
 * Read-only view of the domain → keywords mapping. Exposed so sibling
 * modules (page-facts matcher, documentation generators) can reuse the
 * exact same keyword set without duplicating the source of truth.
 * Returns a NEW object each call so callers can't mutate DOMAIN_MAP.
 */
export function getDomainKeywords(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of DOMAIN_MAP) {
    out[entry.domain] = [...entry.keywords];
  }
  return out;
}

/**
 * Lookup of (domain → route + label) derived from DOMAIN_MAP. Same
 * deduping guarantee as the main map: one entry per domain key.
 */
export function getDomainRoutes(): Record<string, { href: string; label: string }> {
  const out: Record<string, { href: string; label: string }> = {};
  for (const entry of DOMAIN_MAP) {
    out[entry.domain] = { href: entry.href, label: entry.label };
  }
  return out;
}

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
 * Count how many times ANY of a domain's keywords appear in the text.
 * A keyword that appears 3x contributes 3; multiple keywords for the
 * same domain compound. Word-boundary semantics from matchesKeyword.
 */
function countKeywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    // Count non-overlapping occurrences honoring word boundaries for
    // single-word keywords, raw substrings for multi-word ones.
    if (kw.includes(" ")) {
      let start = 0;
      while (true) {
        const idx = lower.indexOf(kw, start);
        if (idx === -1) break;
        hits += 1;
        start = idx + kw.length;
      }
    } else {
      let start = 0;
      while (true) {
        const idx = lower.indexOf(kw, start);
        if (idx === -1) break;
        const left = idx === 0 ? " " : lower[idx - 1];
        const rightIdx = idx + kw.length;
        const right = rightIdx >= lower.length ? " " : lower[rightIdx];
        const isWordChar = (c: string) => /[a-z0-9]/.test(c);
        if (!isWordChar(left) && !isWordChar(right)) hits += 1;
        start = idx + kw.length;
      }
    }
  }
  return hits;
}

/**
 * Same as detectRelatedPages, but unions the hits from the user's
 * question AND the assistant's response text, ORDERED by how strongly
 * each page is referenced overall.
 *
 * Order rule: by descending (response_hits * 3 + question_hits).
 * Response hits are weighted 3x because a page named in the answer
 * is almost always the page the user should actually navigate to,
 * while question mentions are often passing references. Ties break
 * by DOMAIN_MAP index (stable).
 *
 * Regression: previously the function used DOMAIN_MAP order directly,
 * which meant "Calendar" (early in the map) won over "Settings" (late)
 * for a response that mentioned Settings 6x and Calendar 1x. The
 * footer link ended up going to the wrong page.
 */
export function detectRelatedPagesFromExchange(
  question: string,
  responseText: string,
): RelatedPage[] {
  const fromQuestion = detectRelatedPages(question);
  const fromResponse = detectRelatedPages(responseText);
  const seen = new Set<string>();
  const merged: RelatedPage[] = [];
  // Union first (response-first only mattered for tie-break before).
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
  // Sort by (response_hits * 3 + question_hits) descending.
  // Stable so ties preserve DOMAIN_MAP order.
  const keywordsByDomain: Record<string, string[]> = {};
  for (const entry of DOMAIN_MAP) {
    keywordsByDomain[entry.domain] = entry.keywords;
  }
  const scored = merged.map((p, origIdx) => {
    const kws = keywordsByDomain[p.domain] ?? [];
    const responseHits = countKeywordHits(responseText, kws);
    const questionHits = countKeywordHits(question, kws);
    return { p, score: responseHits * 3 + questionHits, origIdx };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.origIdx - b.origIdx;
  });
  return scored.map((s) => s.p);
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
