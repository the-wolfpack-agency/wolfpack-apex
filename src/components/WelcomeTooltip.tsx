"use client";

import { useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

/**
 * First-run welcome tooltip that points at the floating assistant FAB.
 *
 * Shows once per user — persistence is via analytics events
 * (`welcome_tooltip.dismissed` / `welcome_tooltip.knowledge_clicked`),
 * so the learning loop sees the full activation funnel and we don't
 * need a new preferences table.
 *
 * Collapsible: the card can minimize to a single-line pill that hugs
 * the FAB; the user gets the full explanation on demand without the
 * card ever blocking page content.
 */

type State = "loading" | "hidden" | "expanded" | "collapsed";

export default function WelcomeTooltip() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/me/welcome-tooltip");
        if (!res.ok) {
          if (!cancelled) setState("hidden");
          return;
        }
        const data = (await res.json()) as { should_show?: boolean };
        if (cancelled) return;
        setState(data.should_show ? "expanded" : "hidden");
      } catch {
        if (!cancelled) setState("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function post(action: "dismissed" | "knowledge_clicked") {
    try {
      await fetchWithRefresh("/api/me/welcome-tooltip", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action }),
      });
    } catch {
      /* analytics is best-effort; don't block UX on it */
    }
  }

  if (state === "loading" || state === "hidden") return null;

  if (state === "collapsed") {
    return (
      <button
        type="button"
        onClick={() => setState("expanded")}
        className="fixed bottom-24 right-6 z-50 rounded-full px-3 py-1 text-xs font-medium shadow-lg transition-transform hover:scale-105"
        style={{
          background: "var(--wp-gold, #eab308)",
          color: "var(--wp-dark, #111)",
        }}
        data-testid="welcome-tooltip-collapsed"
        aria-label="Expand welcome tip"
      >
        Meet the Assistant →
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-24 right-6 z-50 max-w-xs rounded-xl p-4 shadow-2xl"
      style={{
        background: "var(--wp-dark-surface2, #222)",
        border: "1px solid var(--wp-gold, #eab308)",
        color: "var(--wp-text, #eee)",
      }}
      data-testid="welcome-tooltip"
      role="dialog"
      aria-labelledby="welcome-tooltip-title"
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          id="welcome-tooltip-title"
          className="text-sm font-semibold"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Meet the Wolfpack Assistant
        </h3>
        <button
          type="button"
          onClick={() => setState("collapsed")}
          className="text-xs opacity-70 hover:opacity-100"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
          data-testid="welcome-tooltip-minimize"
          aria-label="Minimize welcome tip"
        >
          —
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed">
        The sparkle button in the bottom-right corner opens the Assistant from
        any page. Ask &ldquo;Calendar&rdquo; or &ldquo;how do I track goals&rdquo; and it
        will link you straight to the right page.
      </p>
      <p className="mt-2 text-xs leading-relaxed">
        Got a question <em>and</em> an answer the whole team should know? Go to
        <strong> Knowledge</strong> and click <strong>Add info</strong> to save
        it — the Assistant will pull from it next time anyone asks.
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <a
          href="/knowledge"
          onClick={() => {
            void post("knowledge_clicked");
          }}
          className="text-xs font-medium underline"
          style={{ color: "var(--wp-gold, #eab308)" }}
          data-testid="welcome-tooltip-knowledge-cta"
        >
          Open Knowledge →
        </a>
        <button
          type="button"
          onClick={() => {
            void post("dismissed");
            setState("hidden");
          }}
          className="text-xs rounded-md px-2 py-1"
          style={{
            background: "var(--wp-dark-surface, #1a1a1a)",
            color: "var(--wp-text-muted, #9ca3af)",
          }}
          data-testid="welcome-tooltip-dismiss"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
