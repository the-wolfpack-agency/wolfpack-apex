"use client";

/**
 * /admin/broadcast — write one message into every team member's assistant.
 *
 * THE WHOLE DESIGN QUESTION HERE IS HOW HARD IT IS TO SEND BY ACCIDENT.
 *
 * Every other compose box in this product writes to one person or one thread.
 * This one writes into everybody's assistant at once and cannot be unsent, so
 * the form asks for a deliberate second action rather than trusting a single
 * click, and it shows the exact recipient count in the confirmation instead of
 * the word "everyone". "Send to 42 people" is a sentence somebody can decline.
 *
 * WHAT IT REFUSES TO ROUND UP. The send path reports delivered, failed and
 * whether the recipient list was readable at all, and this page renders all
 * three. A partial send says which, and an unreadable list says nothing was
 * sent rather than showing a cheerful zero. A sender who is told "delivered"
 * does not send again, so an optimistic success message is the one failure
 * that guarantees the company never hears the thing.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, SectionHeader, StatusPill } from "@/components/console";

/** Mirrors MAX_BROADCAST_CHARS on the server. Longer is a document, not an
 *  announcement, and the server refuses it either way. */
const MAX_CHARS = 2000;

interface SendResult {
  delivered: number;
  failed: number;
  redacted: string[];
}

type Phase =
  | { state: "idle" }
  | { state: "confirming" }
  | { state: "sending" }
  | { state: "sent"; result: SendResult }
  | { state: "error"; message: string };

export default function BroadcastPage() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [recipients, setRecipients] = useState<number | null>(null);

  useEffect(() => {
    /* Redirect rather than render an empty admin page. */
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/broadcast");
      return;
    }
    /* How many people this reaches, read before anything is typed, so the
       number in the confirmation is not the first time it is seen. */
    void (async () => {
      try {
        const res = await fetchWithRefresh("/api/assistant/broadcast");
        if (!res.ok) return;
        const data = (await res.json()) as { recipients?: number; readable?: boolean };
        if (data.readable && typeof data.recipients === "number") setRecipients(data.recipients);
      } catch {
        /* A missing count is not a blocker: the server is the authority on the
           recipient list, and the confirmation says so when this is unknown. */
      }
    })();
  }, [router]);

  const text = message.trim();
  const tooLong = text.length > MAX_CHARS;
  const canSend = text.length > 0 && !tooLong;

  const send = useCallback(async () => {
    setPhase({ state: "sending" });
    try {
      const res = await fetchWithRefresh("/api/assistant/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<SendResult> & {
        error?: string;
        detail?: string;
      };

      if (res.status === 503) {
        setPhase({
          state: "error",
          message:
            "Nothing was sent. The recipient list could not be read, so no one received this. Try again in a moment.",
        });
        return;
      }
      if (!res.ok && res.status !== 207) {
        setPhase({
          state: "error",
          message: body.detail || body.error || `The send failed (${res.status}).`,
        });
        return;
      }

      setPhase({
        state: "sent",
        result: {
          delivered: body.delivered ?? 0,
          failed: body.failed ?? 0,
          redacted: body.redacted ?? [],
        },
      });
      setMessage("");
    } catch {
      setPhase({
        state: "error",
        message: "The send could not be completed. Check your connection and try again.",
      });
    }
  }, [text]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="Announcements"
        title="Message everyone"
        subtitle="Writes one message into every team member's assistant. It cannot be unsent."
      />

      <GlassPanel
        title="Write the announcement"
        subtitle="This appears in each person's assistant as its own conversation, with a feedback form attached so people can respond without a reply thread."
      >
        <label htmlFor="broadcast-message" style={srOnly}>
          Announcement
        </label>
        <textarea
          id="broadcast-message"
          data-testid="broadcast-message"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            /* Editing after a send or a failure clears the old outcome, so a
               stale "sent" banner never sits above a new draft. */
            if (phase.state === "sent" || phase.state === "error" || phase.state === "confirming") {
              setPhase({ state: "idle" });
            }
          }}
          rows={6}
          placeholder="Office closed Monday for the bank holiday."
          style={{
            width: "100%",
            resize: "vertical",
            padding: "0.75rem",
            borderRadius: 8,
            border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
            background: "var(--wp-surface-2, rgba(255,255,255,0.03))",
            color: "var(--wp-text, #e8eaed)",
            font: "inherit",
            lineHeight: 1.5,
          }}
        />

        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: "0.6rem",
          }}
        >
          <span
            data-testid="broadcast-remaining"
            style={{
              fontSize: "0.82rem",
              color: tooLong ? "var(--wp-error, #ef4444)" : "var(--wp-text-dim, #9aa0aa)",
            }}
          >
            {tooLong
              ? `${text.length - MAX_CHARS} characters over the limit`
              : `${MAX_CHARS - text.length} characters left`}
          </span>

          <span style={{ flex: 1 }} />

          {phase.state === "confirming" ? (
            <>
              <button
                type="button"
                data-testid="broadcast-cancel"
                onClick={() => setPhase({ state: "idle" })}
                style={secondaryButton}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="broadcast-confirm"
                onClick={() => void send()}
                style={primaryButton}
              >
                {recipients === null
                  ? "Yes, send to everyone"
                  : `Yes, send to ${recipients} ${recipients === 1 ? "person" : "people"}`}
              </button>
            </>
          ) : (
            /* TWO ACTIONS, NOT ONE. The first click only asks. Nothing that
               writes into every person's assistant should be one click away
               from a stray keystroke. */
            <button
              type="button"
              data-testid="broadcast-send"
              disabled={!canSend || phase.state === "sending"}
              onClick={() => setPhase({ state: "confirming" })}
              style={{ ...primaryButton, opacity: canSend ? 1 : 0.45, cursor: canSend ? "pointer" : "not-allowed" }}
            >
              {phase.state === "sending" ? "Sending…" : "Send to everyone"}
            </button>
          )}
        </div>

        {phase.state === "confirming" ? (
          <p
            data-testid="broadcast-confirm-warning"
            style={{ ...dim, marginTop: "0.75rem" }}
          >
            This writes the message into every team member&apos;s assistant and cannot be unsent.
          </p>
        ) : null}
      </GlassPanel>

      {phase.state === "sent" ? (
        <GlassPanel title="Sent">
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
            <StatusPill
              status={phase.result.failed > 0 ? "partial" : "delivered"}
              tone={phase.result.failed > 0 ? "warning" : "success"}
              label={
                phase.result.failed > 0
                  ? `Delivered to ${phase.result.delivered}, ${phase.result.failed} could not be reached`
                  : `Delivered to ${phase.result.delivered} ${phase.result.delivered === 1 ? "person" : "people"}`
              }
              size="md"
              testId="broadcast-result"
            />
          </div>

          {/* SAID OUT LOUD, because the text people received is not the text
              that was typed, and the sender is the only person who can tell
              whether that mattered. */}
          {phase.result.redacted.length > 0 ? (
            <p data-testid="broadcast-redacted" style={{ ...dim, marginTop: "0.7rem" }}>
              Personal or sensitive details were removed before sending:{" "}
              {phase.result.redacted.join(", ")}. Everyone received the edited version.
            </p>
          ) : null}

          {phase.result.failed > 0 ? (
            <p style={{ ...dim, marginTop: "0.7rem" }}>
              The people who were reached have the message. Sending again would deliver a second
              copy to them, so check with the ones who were missed instead.
            </p>
          ) : null}
        </GlassPanel>
      ) : null}

      {phase.state === "error" ? (
        <GlassPanel title="Not sent">
          <p data-testid="broadcast-error" style={{ margin: 0 }}>
            {phase.message}
          </p>
        </GlassPanel>
      ) : null}
    </div>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.88rem" };

const primaryButton: React.CSSProperties = {
  border: "1px solid var(--wp-gold, #e8b528)",
  background: "var(--wp-gold, #e8b528)",
  color: "#12151a",
  fontWeight: 700,
  fontSize: "0.9rem",
  padding: "0.5rem 0.95rem",
  borderRadius: 8,
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.14))",
  background: "transparent",
  color: "var(--wp-text, #e8eaed)",
  fontWeight: 600,
  fontSize: "0.9rem",
  padding: "0.5rem 0.95rem",
  borderRadius: 8,
  cursor: "pointer",
};

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};
