/**
 * AssistantStarterPrompts — categorized prompt chips for the empty
 * chat state. Helps a new user discover the Assistant's surface
 * area without staring at a blank box.
 *
 * Connection-aware: on mount, we read /api/integrations/status and
 * hide categories whose prompts would 400 because the underlying
 * integration isn't configured. Reason: an unconnected user clicking
 * "top 3 deals" used to get a Salesforce error, which is a terrible
 * first impression and we're the ones who put the chip in front of
 * them. Internal-only categories (Knowledge & memory, Create something
 * partial) always render so the empty state never collapses to nothing.
 *
 * Categories map 1:1 to docs/explainers/assistant-prompts.md.
 */

"use client";

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

/** A single starter chip. `text` is what fires when clicked (and is
 *  rendered in the chip). `description` is a one-line plain-English
 *  explainer surfaced via the native `title=` tooltip on hover, so
 *  users discover what a chip will do before committing to the click.
 *  Hover events are intentionally not analytics-tracked — too noisy. */
export interface StarterPrompt {
  text: string;
  description: string;
}

interface StarterCategory {
  title: string;
  emoji: string;
  prompts: StarterPrompt[];
  /** Provider keys required for chips in this category to actually
   *  work. Empty array = always shown. ANY = shown if any one of the
   *  listed providers is connected (CRM works with SF *or* HubSpot). */
  requires?: { any: ProviderKey[] };
}

type ProviderKey =
  | "microsoft"
  | "salesforce"
  | "hubspot"
  | "github";

interface IntegrationStatus {
  microsoft?: { connected?: boolean };
  salesforce?: { connected?: boolean };
  hubspot?: { connected?: boolean };
  github?: { connected?: boolean };
}

function buildStarterCategories(): StarterCategory[] {
  return [
    {
      /* Always-on demo category — backed by free public APIs (no auth
         required). Lives at the top of the empty state so a brand-new
         user with zero integrations connected still has something
         useful to click in the first 30 seconds. Routes to the
         weather / headlines / fx / search / upload-to-brain tools
         that were added 2026-05-19. */
      title: "Try right now",
      emoji: "👋",
      prompts: [
        {
          text: "weather",
          description: "Current conditions and a short forecast for your default location.",
        },
        {
          text: "what's the weather in Boston",
          description: "Forecast for a specific city. Replace the city name as needed.",
        },
        {
          text: "top news",
          description: "A short public-news digest from a free RSS feed.",
        },
        {
          text: "headlines",
          description: "Same public-news digest under its other common name.",
        },
        {
          text: "exchange rate from USD to EUR",
          description: "FX rate between two currencies; works for any 3-letter ISO pair.",
        },
        {
          text: "fx rate from GBP to JPY",
          description: "Alternative FX phrasing the same tool understands.",
        },
        {
          text: "upload to brain",
          description: "Drop a file into your Brain so the Assistant can cite it later.",
        },
        {
          text: "search Q2 planning",
          description: "Universal search across chats, emails, calendar, knowledge, and CRM.",
        },
        {
          text: "look up anything about Q2 planning",
          description: "Bare-search phrasing that fans into every connected surface in parallel.",
        },
      ],
    },
    {
      /* Widgets first — they're the "interface inside the chat"
         pattern and the most-visited capability on mobile. Lead
         with `briefing` because it's the densest panel (greeting +
         schedule + action items + meeting pre-brief). */
      title: "Widgets",
      emoji: "✨",
      prompts: [
        {
          text: "briefing",
          description:
            "Your morning summary: greeting, today's schedule, unread email digest, and action items.",
        },
        {
          text: "calendar",
          description: "Inline calendar widget for today and the next few days.",
        },
        {
          text: "inbox",
          description: "Inline inbox widget showing your most recent unread messages.",
        },
        {
          text: "tasks",
          description: "Inline task list pulled from Microsoft To Do and Planner.",
        },
      ],
      requires: { any: ["microsoft"] },
    },
    {
      title: "Create something",
      emoji: "✏️",
      prompts: [
        /* create email chip hidden 2026-05-20 — surface isn't ready
           for the Wolfpack (no send confirmation, no attachments,
           thin error handling on rate limits). Re-add when the
           compose path has been hardened end-to-end. */
        {
          text: "create task",
          description: "Add a task to Microsoft To Do with optional due date and reminder.",
        },
        {
          text: "create message",
          description: "Send a Teams chat message to a teammate or channel.",
        },
        {
          text: "schedule a meeting",
          description: "Check your free/busy calendar before booking.",
        },
        {
          text: "create a calendar event",
          description: "Open the new-event form with attendees, time, and optional Teams link.",
        },
        {
          text: "create feature",
          description: "File a new feature request in the internal product backlog.",
        },
        {
          text: "create OKR",
          description: "Add a new objective or key result to the team's OKR tracker.",
        },
      ],
      /* `create feature` and `create OKR` are internal-only and would
         survive a no-MS state, but the majority require MS Graph.
         Rather than split this into two categories we hide it as a
         block — the internal-only fallbacks still appear in
         Knowledge & memory. */
      requires: { any: ["microsoft"] },
    },
    {
      title: "CRM (Salesforce / HubSpot)",
      emoji: "🤝",
      prompts: [
        {
          text: "top 3 deals",
          description: "Your three largest open opportunities by amount.",
        },
        {
          text: "deals over $50k closing this month",
          description: "Pipeline filtered to high-value deals with a close date this month.",
        },
        {
          text: "what's my win rate",
          description: "Percentage of your closed opportunities marked Won over the last quarter.",
        },
        {
          text: "Q3's open opportunities",
          description: "Every open and recent opportunity tied to a parent account or owner. Swap in any name.",
        },
        {
          text: "average deal size",
          description: "Mean closed-won deal value across your recent pipeline.",
        },
        {
          text: "search the CRM for a contact",
          description: "Universal-search phrasing that fans into the CRM alongside chats, emails, calendar, and knowledge. Type a name to narrow.",
        },
        {
          text: "search the CRM for an account",
          description: "Same as above but scoped to accounts/companies.",
        },
        {
          text: "create a new contact",
          description: "Open a CRM contact form so you can fill in name, email, and account.",
        },
        {
          text: "create a new deal",
          description: "Open a CRM deal form so you can capture amount, stage, and close date.",
        },
        {
          text: "move an opportunity to Closed Won",
          description: "Update an opportunity's stage. Confirms before writing.",
        },
        {
          text: "total pipeline value",
          description: "Sum of open opportunity amounts across the pipeline.",
        },
      ],
      requires: { any: ["salesforce", "hubspot"] },
    },
    {
      /* Chips collapsed to the repo-agnostic pattern 2026-05-20. The
         "in wolfpack-instinct" variants 404'd because the actual repo
         is wolfpack-apex (product rename never propagated to the repo
         slug). Keep chip text generic so the tool defaults to "all
         repos you have access to" and stays correct as repos are
         added or renamed. */
      title: "GitHub",
      emoji: "🐙",
      prompts: [
        {
          text: "what PRs are open",
          description: "Open pull requests across the repos you have access to.",
        },
        {
          text: "open github issues in wolfpack-apex",
          description: "Currently open issues in the wolfpack-apex repo, newest first.",
        },
        {
          text: "recent workflow runs in wolfpack-apex",
          description: "Latest GitHub Actions runs (pass + fail) in the wolfpack-apex repo.",
        },
        {
          text: "failed CI runs in wolfpack-apex",
          description: "Most recent failing GitHub Actions runs in the wolfpack-apex repo.",
        },
      ],
      requires: { any: ["github"] },
    },
    {
      title: "Calendar & Mail",
      emoji: "📅",
      prompts: [
        {
          text: "what is on my calendar monday?",
          description: "Every event on your calendar for the upcoming Monday.",
        },
        {
          text: "am I free Thursday at 2pm",
          description: "Checks your calendar for conflicts at the given day and time.",
        },
        {
          text: "find emails about pricing",
          description: "Search your inbox for messages on a topic. Swap in any subject.",
        },
        {
          text: "find emails about Q2 planning",
          description: "Topic-based mail search. Swap in any subject you care about.",
        },
        {
          text: "any meetings tomorrow",
          description: "Lists tomorrow's scheduled meetings and their attendees.",
        },
        {
          text: "am I free Wednesday afternoon",
          description: "Block-of-day availability check before booking a call.",
        },
        {
          text: "find emails about a project",
          description: "Topic-only mail search. Swap in any subject you care about.",
        },
      ],
      requires: { any: ["microsoft"] },
    },
    {
      title: "Knowledge & memory",
      emoji: "📚",
      prompts: [
        {
          text: "what are our OKRs",
          description: "Pulls the team's current objectives and key results from the knowledge base.",
        },
        {
          text: "show me my goals",
          description: "Your active goals and progress from the goals tracker.",
        },
        {
          text: "tell me about our company",
          description: "One-line org summary pulled from the knowledge store.",
        },
        {
          text: "what do we know about our pipeline",
          description: "Everything the assistant has indexed about a subject: notes, deals, contacts.",
        },
        {
          text: "who is on our team",
          description: "Roster lookup. Type a name after `who is` to look up a specific person.",
        },
        {
          text: "tell me about our Q2 plan",
          description: "Org-facts retrieval against any indexed subject.",
        },
        {
          text: "remember that our team's priority is shipping",
          description: "Save a team fact. The Assistant confirms before persisting.",
        },
        {
          text: "remember that Q3's target is high growth",
          description: "Save an attribute-style fact. The Assistant confirms before writing.",
        },
      ],
    },
    {
      /* Financials — restricted by capability (CTO/CEO) at dispatch
         time, not at chip render time. Anyone can click; the
         dispatcher returns a polite capability error for non-execs. */
      title: "Financials",
      emoji: "💵",
      prompts: [
        {
          text: "what's our MRR",
          description: "Current monthly recurring revenue.",
        },
        {
          text: "what's our revenue this quarter",
          description: "Quarter-to-date revenue from the financials store.",
        },
        {
          text: "what's our burn",
          description: "Current monthly burn rate.",
        },
        {
          text: "what's our runway",
          description: "Months of cash runway at current burn.",
        },
      ],
    },
    {
      /* Help-us-improve category — surfaces the /feedback slash
         command so non-dev teammates have a one-click way to file
         honest reactions during the team-onboarding session. Always
         renders (no requires); writes go through the assistant tool
         + /api/feedback (capability: assistant.use). Kept name-free
         per the chip-text convention. */
      title: "Help us improve",
      emoji: "🗣",
      prompts: [
        {
          /* Bare "feedback" opens the form widget for the user to
             type into. The longer chip ("share feedback about
             Instinct") was being parsed by the intent router as
             feedback-tool + body="about Instinct", submitting an
             empty-ish note immediately. Confirmed live 2026-05-20. */
          text: "feedback",
          description: "Open a feedback note. The CTO sees every reply.",
        },
        {
          text: "/feedback the calendar widget is broken",
          description: "Slash-command form: type /feedback followed by your note to file it immediately.",
        },
      ],
    },
    {
      /* Dealership / inventory category — only useful for workspaces
         that have a DMS adapter configured (wolfpack-auto first; CDK /
         Tekion / Reynolds plug in server-side). Chip stays visible
         everywhere; the tool itself returns "no inventory data" if
         the adapter isn't wired. */
      title: "Inventory",
      emoji: "🚗",
      prompts: [
        {
          text: "show me Honda inventory",
          description: "Open the DMS inventory widget filtered to a make.",
        },
        {
          text: "Toyota Camry inventory under $30k",
          description: "Filter by make, model, and price ceiling.",
        },
        {
          text: "2024 Ford F-150 stock",
          description: "Year + make + model search against the dealership DMS.",
        },
      ],
    },
  ];
}

const STARTER_CATEGORIES: StarterCategory[] = buildStarterCategories();

/** Test seam — surfaces the same data the component renders so coverage
 *  suites can assert every chip routes to a tool. Mirrors the internal
 *  buildStarterCategories() result; not used at runtime. */
export function buildStarterCategoriesForTest(): StarterCategory[] {
  return buildStarterCategories();
}

export function filterCategoriesByStatus(
  cats: StarterCategory[],
  status: IntegrationStatus | null,
): StarterCategory[] {
  /* Pre-connection-check (status still loading): show only categories
   * with no requirements. This avoids briefly flashing chips the user
   * can't use, then yanking them. */
  if (status === null) {
    return cats.filter((c) => !c.requires || c.requires.any.length === 0);
  }
  return cats.filter((c) => {
    if (!c.requires || c.requires.any.length === 0) return true;
    return c.requires.any.some((key) => status[key]?.connected === true);
  });
}

export interface AssistantStarterPromptsProps {
  /** Called when the user clicks a chip. The parent (InstinctChat)
   *  is expected to populate the composer and fire the message. */
  onPick: (prompt: string) => void;
}

export function AssistantStarterPrompts({ onPick }: AssistantStarterPromptsProps) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithRefresh("/api/integrations/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: IntegrationStatus | null) => {
        if (!cancelled) setStatus(data ?? {});
      })
      .catch(() => {
        if (!cancelled) setStatus({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Filter empty categories so a section never renders an expanded
   *  header above zero chips. The connector-status filter handles
   *  the typical case; this is a belt-and-suspenders guard for any
   *  category whose prompts list resolves to zero at render time. */
  const visibleCategories = filterCategoriesByStatus(STARTER_CATEGORIES, status)
    .filter((c) => c.prompts.length > 0);
  const missingConnections = collectMissingConnections(STARTER_CATEGORIES, status);

  /* All categories collapsed by default so the empty state stays
   *  compact and the greeting stays above the fold. Tap a header to
   *  expand. Both mobile and desktop start fully collapsed — desktop
   *  users get a denser overview and choose what to explore. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (title: string) =>
    setExpanded((prev) => ({ ...prev, [title]: !prev[title] }));

  return (
    <div
      className="mt-4 sm:mt-6 w-full max-w-2xl px-3"
      data-testid="assistant-starter-prompts"
    >
      <div
        className="text-xs uppercase tracking-wide mb-2 sm:mb-3 text-center"
        style={{ color: "var(--wp-text-muted, #6b7280)", letterSpacing: 1 }}
      >
        Try one of these
      </div>
      {/* CSS multi-column packs collapsed cards tightly (no row-by-row
       *  dead space that grid-cols-2 produces when one column has a
       *  much taller expanded section than the other). break-inside-
       *  avoid keeps each card together. */}
      <div className="columns-1 sm:columns-2 gap-2 sm:gap-3 [&>div]:break-inside-avoid [&>div]:mb-2 [&>div:last-child]:mb-0">
        {visibleCategories.map((cat) => {
          const isOpen = expanded[cat.title];
          const slug = cat.title.toLowerCase().replace(/\W+/g, "-");
          return (
            <div
              key={cat.title}
              className="rounded-md"
              style={{
                background: "var(--wp-dark-surface2, #1a1a1a)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <button
                type="button"
                onClick={() => toggle(cat.title)}
                data-testid={`starter-category-toggle-${slug}`}
                className="flex w-full items-center justify-between p-2.5 sm:p-3 text-left"
                aria-expanded={isOpen}
              >
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  <span className="mr-1.5">{cat.emoji}</span>
                  {cat.title}
                </span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {isOpen && (
                <div className="flex flex-wrap gap-1.5 px-2.5 sm:px-3 pb-2.5 sm:pb-3">
                  {cat.prompts.map((p) => (
                    <button
                      key={p.text}
                      type="button"
                      onClick={() => onPick(p.text)}
                      /* Native browser tooltip on hover. No design lib;
                         intentionally not analytics-tracked because hover
                         volume drowns out clicks. */
                      title={p.description}
                      data-testid={`starter-prompt-${slug}-${p.text.slice(0, 20).replace(/\W+/g, "-")}`}
                      className="text-xs px-2 py-1 rounded-md transition-colors hover:opacity-90 text-left"
                      style={{
                        background: "rgba(234,179,8,0.08)",
                        color: "var(--wp-gold, #eab308)",
                        border: "1px solid rgba(234,179,8,0.25)",
                      }}
                    >
                      {p.text}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {missingConnections.length > 0 && (
        <div
          data-testid="starter-prompts-connect-hint"
          className="text-xs mt-3 text-center px-3"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Unlock {missingConnections.join(", ")} prompts in{" "}
          <a
            href="/settings"
            className="underline"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Settings → Integrations
          </a>
          .
        </div>
      )}
    </div>
  );
}

/** Human-readable list of integration groups the workspace has not
 *  connected yet, used to drive the "unlock more prompts" footer.
 *  Returns an empty list while status is still loading so the hint
 *  doesn't flash. */
function collectMissingConnections(
  cats: StarterCategory[],
  status: IntegrationStatus | null,
): string[] {
  if (status === null) return [];
  const missing = new Set<string>();
  for (const c of cats) {
    if (!c.requires || c.requires.any.length === 0) continue;
    const anyConnected = c.requires.any.some(
      (k) => status[k]?.connected === true,
    );
    if (!anyConnected) {
      if (c.requires.any.includes("microsoft")) missing.add("Microsoft 365");
      if (
        c.requires.any.includes("salesforce") ||
        c.requires.any.includes("hubspot")
      ) {
        missing.add("CRM");
      }
      if (c.requires.any.includes("github")) missing.add("GitHub");
    }
  }
  return Array.from(missing);
}
