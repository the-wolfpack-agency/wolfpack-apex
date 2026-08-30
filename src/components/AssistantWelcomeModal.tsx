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
  welcomePromptsFor,
  welcomePromptsForRole,
  type AvailableSources,
  type WelcomePrompt,
} from "@/lib/assistant/welcome-prompts";

const STORAGE_KEY = "instinct_welcome_seen";

/**
 * Which connector backs which prompt requirement.
 *
 * `documents` is deliberately ABSENT. It is the Phase 1 capability and is not
 * gated on a connector: a workspace can hold documents from a SharePoint sync
 * or from somebody dropping a file in, so there is no single flag that means
 * "no documents". Leaving it unmapped leaves it undefined, and welcomePromptsFor
 * hides only what is explicitly false, so the document prompt always shows.
 * That is the right default for the one thing this product is being sold on.
 */
function sourcesFromStatus(status: {
  microsoft?: { connected?: boolean };
  quickbooks?: { connected?: boolean };
}): AvailableSources {
  const ms = status.microsoft?.connected === true;
  const qbo = status.quickbooks?.connected === true;
  return { calendar: ms, mail: ms, tasks: ms, financials: qbo };
}

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
  /**
   * What the deployment can actually do, once we have asked.
   *
   * Null until the check completes or fails. The distinction matters: it is
   * the difference between "these six work" and "these six exist", and the
   * modal says something different in each case rather than claiming the
   * stronger one by default.
   */
  const [available, setAvailable] = useState<AvailableSources | null>(null);
  /* Unfiltered fallback, used while the check is in flight or if it fails. A
     prompt we could not verify is still worth offering; hiding a working
     capability because a status call failed is the worse error. */
  const promptsRef = useRef<WelcomePrompt[]>(welcomePromptsForRole(userRole));
  const prompts = available
    ? welcomePromptsFor(userRole, available)
    : promptsRef.current;

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

  /* ESCAPE CLOSES IT.
   *
   * It did not, and the modal covers the answer. Measured against the live
   * deployment 2026-08-29: click-outside dismissed it and the dismissal
   * persisted correctly across a reload, but Escape did nothing, so anybody
   * whose reflex is Escape sits looking at a panel over their own results and
   * concludes it is stuck.
   *
   * Cheap to get wrong in a demo and invisible in every test that clicks,
   * because a test that clicks never presses a key.
   *
   * Bound while OPEN only, so this adds no listener to a page whose modal is
   * already dismissed, and removed on close. */
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") handleDismiss("escape");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    /* handleDismiss is stable for the life of the open modal: it closes over
       setOpen and userRole only, and userRole is in the dependency list. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userRole]);

  /* TYPING YOUR OWN QUESTION CLOSES IT.
   *
   * It did not, and the consequence was worse than a stuck panel. The composer
   * sits above this backdrop, so somebody can type past the modal and send:
   * measured in real Chromium on 2026-08-30, a first visit accepted the
   * question, streamed the answer, and left the modal open ON TOP of it. Every
   * control on that answer, the sources, the copy button, the feedback
   * buttons, resolved to the backdrop rather than to itself and did nothing
   * when clicked.
   *
   * That is the worst version of this bug, because nothing looks broken. The
   * answer is right there, greyed slightly, and the buttons simply ignore you.
   *
   * Escape and click-outside were both added earlier, by measuring, and both
   * miss this: somebody who types their own question never presses Escape and
   * never clicks the backdrop. The modal exists to suggest a first question,
   * so the moment somebody writes their own it has done its job.
   *
   * Listens for INPUT rather than focus, because a composer that autofocuses
   * on load would dismiss this before it was ever read. Ignores input inside
   * the panel itself, so a future search box in here cannot close it. */
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    function onInput(e: Event): void {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isTextEntry =
        target.tagName === "TEXTAREA" ||
        (target.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(
          (target as HTMLInputElement).type,
        ));
      if (!isTextEntry) return;
      if (target.closest('[data-testid="assistant-welcome-modal"]')) return;
      handleDismiss("typed_own_question");
    }
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userRole]);

  /* ASK WHAT IS CONNECTED BEFORE PROMISING IT WORKS.
   *
   * The modal offered six prompts under "each one works right now, no setup
   * needed", built from welcomePromptsForRole, which does not filter. So a
   * workspace with no QuickBooks was shown "what's our MRR" and answered
   * "financials are not connected yet" — measured on the live deployment
   * 2026-08-29. On a documents-only Phase 1 deployment four of the six need a
   * connector nobody has set up.
   *
   * welcomePromptsFor and /api/integrations/status both already existed; they
   * had simply never been introduced to each other.
   *
   * Only while OPEN: a dismissed modal must not cost a request on every page. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/integrations/status");
        if (!res.ok) return;
        const status = (await res.json()) as Parameters<typeof sourcesFromStatus>[0];
        if (!cancelled) setAvailable(sourcesFromStatus(status));
      } catch {
        /* Leave it null. The modal then shows the unfiltered kit and softens
           its claim, rather than hiding capabilities because a call failed. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function markSeen(): void {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* quota / private-mode: still close UX, just may re-show next visit */
      }
    }
  }

  function handleDismiss(
    method: "x_button" | "click_outside" | "escape" | "typed_own_question",
  ): void {
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
          {available
            ? "Try one of these to get started. Each one works right now — no setup needed."
            : "Try one of these to get started."}
        </p>
        <ul className="space-y-2">
          {prompts.map((p) => (
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
