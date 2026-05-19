"use client";

/**
 * AssistantWelcomeModal — one-time first-visit greeter on /assistant.
 *
 * Why: brand-new users (Alicia / Ashley / Meghan in the rollout) land
 * on a blank chat with starter chips and have no idea where to begin.
 * The modal shows three role-tailored prompts and asks them to pick
 * one. Picking auto-fills the composer; dismissing closes the modal
 * without firing anything.
 *
 * Persistence: localStorage key `instinct_welcome_seen` flips to "1"
 * after the first dismiss / pick. We never re-show it for the same
 * browser. Per-user / per-device — we accept that a user with two
 * laptops will see it twice. That's fine; it's a 5-second modal.
 *
 * Analytics: 3 events flow into the existing /api/analytics endpoint
 * the rest of the chat surface uses — keeps the welcome funnel
 * inside the same dashboards as everything else.
 */

import { useEffect, useRef, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  welcomePromptsForRole,
  type WelcomePrompt,
} from "@/lib/assistant/welcome-prompts";

const STORAGE_KEY = "instinct_welcome_seen";

function track(event: string, metadata: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  void fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

export interface AssistantWelcomeModalProps {
  /** First-name of the user for the greeting line. Falls back to
   *  "there" so an unknown user still gets a friendly message. */
  userName?: string | null;
  /** User role — drives which 3 prompts appear. */
  userRole?: string | null;
  /** Called when the user picks a prompt. Parent fills the composer
   *  with the prompt text. The modal handles the dismiss + storage
   *  side effects itself. */
  onPickPrompt: (prompt: string) => void;
}

export function AssistantWelcomeModal({
  userName,
  userRole,
  onPickPrompt,
}: AssistantWelcomeModalProps) {
  const [open, setOpen] = useState(false);
  const promptsRef = useRef<WelcomePrompt[]>(welcomePromptsForRole(userRole));

  /* First-visit gate: open the modal once, persist the flag on close
   * so a future visit doesn't re-open. Reading sessionStorage at
   * render time would cause SSR hydration mismatch, so we run inside
   * an effect. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(STORAGE_KEY) === "1";
    if (!seen) {
      setOpen(true);
      track("assistant.welcome_shown", { role: userRole ?? "unknown" });
    }
  }, [userRole]);

  function markSeen(): void {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* quota / private-mode: still close UX, just may re-show next visit */
      }
    }
  }

  function handleDismiss(method: "x_button" | "click_outside"): void {
    setOpen(false);
    markSeen();
    track("assistant.welcome_dismissed", { method, role: userRole ?? "unknown" });
  }

  function handlePick(prompt: WelcomePrompt): void {
    setOpen(false);
    markSeen();
    track("assistant.welcome_prompt_clicked", {
      prompt: prompt.text,
      /* chip_label is the visible button text (may differ from prompt
       * when a short label is paired with a longer natural-language
       * prompt). Lets the funnel report on the surface users see. */
      chip_label: prompt.label ?? prompt.text,
      role: userRole ?? "unknown",
      user_role: userRole ?? "unknown",
    });
    onPickPrompt(prompt.text);
  }

  if (!open) return null;

  const greetingName = userName?.split(" ")[0] || "there";

  return (
    <div
      data-testid="assistant-welcome-modal-backdrop"
      onClick={() => handleDismiss("click_outside")}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="instinct-welcome-title"
    >
      <div
        data-testid="assistant-welcome-modal"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl p-6 shadow-2xl"
        style={{
          background: "var(--wp-dark-surface2, #1a1a1a)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <h2
            id="instinct-welcome-title"
            className="text-lg font-semibold"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Hi {greetingName}, I&rsquo;m Instinct.
          </h2>
          <button
            type="button"
            onClick={() => handleDismiss("x_button")}
            data-testid="assistant-welcome-modal-close"
            className="p-1 rounded transition-colors hover:opacity-80"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
            aria-label="Close welcome"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p
          className="text-sm mb-5"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          Try one of these to get started. Each one works right now &mdash;
          no setup needed.
        </p>
        <ul className="space-y-2">
          {promptsRef.current.map((p) => (
            <li key={p.text}>
              <button
                type="button"
                onClick={() => handlePick(p)}
                data-testid={`assistant-welcome-prompt-${p.text.slice(0, 24).replace(/\W+/g, "-")}`}
                className="w-full text-left rounded-lg px-4 py-3 transition-colors hover:opacity-90"
                style={{
                  background: "rgba(234,179,8,0.08)",
                  border: "1px solid rgba(234,179,8,0.25)",
                  color: "var(--wp-text, #eee)",
                }}
              >
                <div
                  className="text-sm font-semibold"
                  style={{ color: "var(--wp-gold, #eab308)" }}
                >
                  {p.label ?? p.text}
                </div>
                <div
                  className="text-xs mt-0.5"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {p.description}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <p
          className="text-xs mt-5 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          You can always come back to these from the chat&rsquo;s starter
          chips.
        </p>
      </div>
    </div>
  );
}
