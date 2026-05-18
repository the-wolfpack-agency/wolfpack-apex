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
        {
          text: "create email",
          description: "Draft a new email; you'll be asked for recipient, subject, and body.",
        },
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
          description: "Book a calendar meeting with attendees, time, and optional Teams link.",
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
          text: "<account>'s opportunities",
          description: "Every open and recent opportunity tied to a named account.",
        },
        {
          text: "average deal size",
          description: "Mean closed-won deal value across your recent pipeline.",
        },
      ],
      requires: { any: ["salesforce", "hubspot"] },
    },
    {
      title: "GitHub",
      emoji: "🐙",
      prompts: [
        {
          text: "what PRs are open",
          description: "Open pull requests across the repos you have access to.",
        },
        {
          text: "failed CI in <repo>",
          description: "Most recent failing GitHub Actions runs for the chosen repository.",
        },
        {
          text: "open issues in <repo>",
          description: "Currently open issues in the chosen repository, newest first.",
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
          text: "find emails from <person>",
          description: "Search your inbox for messages sent by a named person.",
        },
        {
          text: "find emails to <person>",
          description: "Search your sent items for messages you addressed to a named person.",
        },
        {
          text: "any meetings tomorrow",
          description: "Lists tomorrow's scheduled meetings and their attendees.",
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
          text: "what's our revenue this quarter?",
          description: "Quarter-to-date revenue from the financial knowledge store.",
        },
        {
          text: "what do we know about <account>",
          description: "Everything the assistant has indexed about a named account: notes, deals, contacts.",
        },
        {
          text: "who is <teammate>",
          description: "Role, team, and recent activity for a named teammate from the org directory.",
        },
      ],
    },
  ];
}

const STARTER_CATEGORIES: StarterCategory[] = buildStarterCategories();

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

  const visibleCategories = filterCategoriesByStatus(STARTER_CATEGORIES, status);
  const missingConnections = collectMissingConnections(STARTER_CATEGORIES, status);

  /* On mobile (default), only the first visible category is expanded
     so the empty state stays compact and chip rows don't push the
     greeting above the fold. Tapping a category header expands it.
     On desktop the screenshot bug doesn't apply — every category is
     expanded by default. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    const isMobile =
      typeof window !== "undefined" && window.innerWidth < 640;
    STARTER_CATEGORIES.forEach((c, i) => {
      out[c.title] = isMobile ? i === 0 : true;
    });
    return out;
  });

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
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
            href="/settings/integrations"
            className="underline"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Settings → Integrations
          </a>
          .
        </div>
      )}
      <div
        className="text-xs mt-2 sm:mt-3 text-center px-3"
        style={{ color: "var(--wp-text-muted, #6b7280)" }}
      >
        Full prompt catalogue: <code>docs/explainers/assistant-prompts.md</code>
      </div>
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
