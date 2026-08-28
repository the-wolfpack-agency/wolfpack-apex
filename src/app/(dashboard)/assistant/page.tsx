"use client";

import { useState } from "react";
import InstinctChat from "@/components/InstinctChat";
import { AssistantSupportPanel } from "@/components/AssistantSupportPanel";
import { ConsoleShell } from "@/components/console";

/**
 * /assistant — the wolfpack's daily-driver chat surface.
 *
 * Two modes share the page:
 *   1. The default InstinctChat (full RAG + tool-use pipeline).
 *   2. A "Support" pill at the top that swaps in a token-efficient
 *      semantic Q&A cache (migration 108 + /api/knowledge/ask). The
 *      support mode is meant to deflect tickets — it answers common
 *      questions inline before the user opens a ticket. If the answer
 *      is low-confidence the panel surfaces a "Submit a support
 *      ticket" CTA below it.
 *
 * Why a pill instead of intent-detection on the main composer:
 *   * Intent-classification adds latency and ambiguity to EVERY
 *     message. A user pill is explicit, opt-in, and lets us measure
 *     the deflection rate cleanly via the assistant.support_query
 *     event.
 */
export default function AssistantPage() {
  const [supportOpen, setSupportOpen] = useState(false);
  return (
    /* THE SHARED FRAME. This page used none of the console kit, while
       /admin/agents and /admin/ai-router both did, so three surfaces a client
       moves between looked like three products.

       `fill` because a conversation owns the viewport rather than flowing as a
       document: without it the shell adds a second scroll container and the
       chat scrolls inside a page that also scrolls. */
    <ConsoleShell fill testId="assistant-shell">
      <div className="flex flex-col h-full">
        <div className="pb-2 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            data-testid="assistant-support-pill"
            onClick={() => setSupportOpen((v) => !v)}
            className="text-xs px-3 py-1 rounded-full font-semibold transition-colors border"
            style={{
              background: supportOpen ? "var(--wp-gold)" : "var(--wp-dark-surface2)",
              borderColor: "var(--wp-dark-border)",
              color: supportOpen ? "var(--wp-dark)" : "var(--wp-text)",
            }}
          >
            {supportOpen ? "Close support" : "Ask a support question"}
          </button>
          <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
            Get a quick self-serve answer before submitting a ticket.
          </span>
        </div>
        {supportOpen && <AssistantSupportPanel />}
        <div className="flex-1 min-h-0">
          <InstinctChat />
        </div>
      </div>
    </ConsoleShell>
  );
}
