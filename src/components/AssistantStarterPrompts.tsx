/**
 * AssistantStarterPrompts — categorized prompt chips for the empty
 * chat state. Helps a new user discover the Assistant's surface
 * area: there's enough breadth (CRM / GitHub / calendar / mail /
 * forms / goals) that "Ask anything" leaves users staring at a blank
 * box.
 *
 * Categories map 1:1 to docs/explainers/assistant-prompts.md so the
 * docs and the UI stay in lockstep. Each chip injects a known-good
 * verified prompt — clicking sends it as a real user message.
 */

"use client";

import { useState } from "react";

interface StarterCategory {
  title: string;
  emoji: string;
  prompts: string[];
}

const STARTER_CATEGORIES: StarterCategory[] = [
  {
    title: "Create something",
    emoji: "✏️",
    prompts: [
      "create email",
      "create task",
      "create message",
      "schedule a meeting",
      "create feature",
      "create OKR",
    ],
  },
  {
    title: "CRM (Salesforce / HubSpot)",
    emoji: "🤝",
    prompts: [
      "top 3 deals",
      "deals over $50k closing this month",
      "what's my win rate",
      "Acme's opportunities",
      "average deal size",
    ],
  },
  {
    title: "GitHub",
    emoji: "🐙",
    prompts: [
      "what PRs are open",
      "failed CI in wolfpack-apex",
      "open issues in wolfpack-auto",
    ],
  },
  {
    title: "Calendar & Mail",
    emoji: "📅",
    prompts: [
      "what is on my calendar monday?",
      "am I free Thursday at 2pm",
      "find emails from Max",
    ],
  },
  {
    title: "Internal",
    emoji: "📚",
    prompts: [
      "what are our OKRs",
      "what's our revenue this quarter?",
      "what do we know about Acme",
    ],
  },
];

export interface AssistantStarterPromptsProps {
  /** Called when the user clicks a chip. The parent (InstinctChat)
   *  is expected to populate the composer and fire the message. */
  onPick: (prompt: string) => void;
}

export function AssistantStarterPrompts({ onPick }: AssistantStarterPromptsProps) {
  /* On mobile (default), only the first category is expanded so the
     empty state stays compact and the chip rows don't push the
     greeting above the fold. Tapping a category header expands it.
     On desktop the screenshot bug doesn't apply — every category is
     expanded by default. We detect via a useState seeded from
     window.innerWidth so SSR + first paint are stable. */
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
        {STARTER_CATEGORIES.map((cat) => {
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
                      key={p}
                      type="button"
                      onClick={() => onPick(p)}
                      data-testid={`starter-prompt-${slug}-${p.slice(0, 20).replace(/\W+/g, "-")}`}
                      className="text-xs px-2 py-1 rounded-md transition-colors hover:opacity-90 text-left"
                      style={{
                        background: "rgba(234,179,8,0.08)",
                        color: "var(--wp-gold, #eab308)",
                        border: "1px solid rgba(234,179,8,0.25)",
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div
        className="text-xs mt-2 sm:mt-3 text-center px-3"
        style={{ color: "var(--wp-text-muted, #6b7280)" }}
      >
        Full prompt catalogue: <code>docs/explainers/assistant-prompts.md</code>
      </div>
    </div>
  );
}
