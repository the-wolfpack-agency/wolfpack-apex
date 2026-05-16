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
  return (
    <div
      className="mt-6 w-full max-w-2xl"
      data-testid="assistant-starter-prompts"
    >
      <div
        className="text-xs uppercase tracking-wide mb-3 text-center"
        style={{ color: "var(--wp-text-muted, #6b7280)", letterSpacing: 1 }}
      >
        Try one of these
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {STARTER_CATEGORIES.map((cat) => (
          <div
            key={cat.title}
            className="rounded-md p-3"
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px solid var(--wp-dark-border, #333)",
            }}
          >
            <div
              className="text-xs font-semibold mb-2"
              style={{ color: "var(--wp-text-dim, #aaa)" }}
            >
              <span className="mr-1.5">{cat.emoji}</span>
              {cat.title}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cat.prompts.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPick(p)}
                  data-testid={`starter-prompt-${cat.title.toLowerCase().replace(/\W+/g, "-")}-${p.slice(0, 20).replace(/\W+/g, "-")}`}
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
          </div>
        ))}
      </div>
      <div
        className="text-xs mt-3 text-center"
        style={{ color: "var(--wp-text-muted, #6b7280)" }}
      >
        Full prompt catalogue: <code>docs/explainers/assistant-prompts.md</code>
      </div>
    </div>
  );
}
