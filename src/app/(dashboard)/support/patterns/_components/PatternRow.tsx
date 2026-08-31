"use client";

/**
 * PatternRow — a single row on /support/patterns.
 *
 * Renders one pattern as a clickable card showing slug, name, category,
 * enabled status, success / fail counts, plus a prominent auto-ack
 * toggle. Clicking the row body expands an edit panel that lets the
 * operator rewrite `auto_acknowledge_template` (the starting point the
 * AI rephrases for inbound replies).
 *
 * State machine:
 *   - idle     : no pending PATCH
 *   - saving   : PATCH inflight
 *   - saved    : PATCH succeeded; brief pulse before returning to idle
 *   - error    : PATCH failed; surface the message inline
 *
 * Color tokens reuse the existing palette so the page sits next to the
 * rest of the dashboard without visual drift:
 *   green = rgba(80,175,110,*)  enabled / success
 *   gray  = rgba(160,168,180,*) disabled / muted
 *   red   = rgba(232,123,123,*) error
 *   blue  = rgba(82,154,232,*)  info / auto-ack accent
 *
 * Props are intentionally minimal: parent owns the optimiztic state
 * after a PATCH, so the row can stay a controlled component.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

import type { SupportPattern } from "@/lib/support/types";

export interface PatternRowProps {
  pattern: SupportPattern;
  /** Parent's commit-hook. Receives the server-truth row after a
   *  successful PATCH so the parent can re-render with fresh values. */
  onPatched: (updated: SupportPattern) => void;
}

const SAVED_PULSE_MS = 1100;

export default function PatternRow({ pattern, onPatched }: PatternRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<string>(
    pattern.auto_acknowledge_template ?? "",
  );
  const [savingField, setSavingField] = useState<
    null | "toggle_enabled" | "toggle_auto_ack" | "template"
  >(null);
  const [savedField, setSavedField] = useState<
    null | "toggle_enabled" | "toggle_auto_ack" | "template"
  >(null);
  const [error, setError] = useState<string | null>(null);

  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Reset the local template draft whenever the parent passes a new
     row in (e.g. another row finished saving and the parent re-fetched
     the list). Guards against the textarea desyncing from server truth. */
  useEffect(() => {
    setTemplateDraft(pattern.auto_acknowledge_template ?? "");
  }, [pattern.auto_acknowledge_template]);

  useEffect(() => {
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  const flashSaved = useCallback(
    (which: "toggle_enabled" | "toggle_auto_ack" | "template") => {
      setSavedField(which);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(
        () => setSavedField(null),
        SAVED_PULSE_MS,
      );
    },
    [],
  );

  const patch = useCallback(
    async (
      field: "toggle_enabled" | "toggle_auto_ack" | "template",
      payload: Record<string, unknown>,
    ) => {
      setSavingField(field);
      setError(null);
      try {
        const res = await fetchWithRefresh(
          `/api/support/patterns/${pattern.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const errText = await safeError(res);
          setError(errText);
          return;
        }
        const data = (await res.json()) as { pattern: SupportPattern };
        onPatched(data.pattern);
        flashSaved(field);
      } catch (err) {
        setError(`We couldn't save: ${(err as Error).message}`);
      } finally {
        setSavingField(null);
      }
    },
    [pattern.id, onPatched, flashSaved],
  );

  const onToggleEnabled = useCallback(() => {
    void patch("toggle_enabled", { enabled: !pattern.enabled });
  }, [pattern.enabled, patch]);

  const onToggleAutoAck = useCallback(() => {
    void patch("toggle_auto_ack", {
      auto_acknowledge_enabled: !(pattern.auto_acknowledge_enabled === true),
    });
  }, [pattern.auto_acknowledge_enabled, patch]);

  const onSaveTemplate = useCallback(() => {
    void patch("template", {
      auto_acknowledge_template: templateDraft.length > 0 ? templateDraft : null,
    });
  }, [patch, templateDraft]);

  const autoAckOn = pattern.auto_acknowledge_enabled === true;
  const dirty =
    (pattern.auto_acknowledge_template ?? "") !== templateDraft;

  return (
    <li
      data-testid={`pattern-row-${pattern.id}`}
      data-pattern-slug={pattern.slug}
      data-auto-ack-enabled={autoAckOn ? "true" : "false"}
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1rem 1.1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.8rem",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          data-testid={`pattern-row-expand-${pattern.id}`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--wp-text)",
            padding: 0,
            textAlign: "left",
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: "1rem",
              fontWeight: 600,
              wordBreak: "break-word",
            }}
          >
            {pattern.name}
          </div>
          <div
            style={{
              marginTop: "0.15rem",
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            {pattern.slug} · {pattern.category}
          </div>
        </button>

        <span
          data-testid={`pattern-row-counts-${pattern.id}`}
          style={{
            fontSize: "0.78rem",
            color: "var(--wp-text-dim)",
            whiteSpace: "nowrap",
          }}
          title="Helpful vs. not-helpful feedback"
        >
          <span style={{ color: "rgba(80,175,110,0.95)" }}>
            ↑ {pattern.success_count}
          </span>
          {"  "}
          <span style={{ color: "rgba(232,123,123,0.95)" }}>
            ↓ {pattern.fail_count}
          </span>
        </span>

        <ToggleButton
          testId={`pattern-row-toggle-enabled-${pattern.id}`}
          label="Enabled"
          on={pattern.enabled}
          saving={savingField === "toggle_enabled"}
          saved={savedField === "toggle_enabled"}
          onClick={onToggleEnabled}
        />
        <ToggleButton
          testId={`pattern-row-toggle-auto-ack-${pattern.id}`}
          label="Auto-ack"
          on={autoAckOn}
          saving={savingField === "toggle_auto_ack"}
          saved={savedField === "toggle_auto_ack"}
          onClick={onToggleAutoAck}
        />
      </header>

      {error ? (
        <div
          data-testid={`pattern-row-error-${pattern.id}`}
          role="alert"
          style={{
            background: "rgba(232,123,123,0.12)",
            border: "1px solid rgba(232,123,123,0.45)",
            color: "rgb(232,150,150)",
            padding: "0.5rem 0.7rem",
            borderRadius: 6,
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      ) : null}

      {expanded ? (
        <div
          data-testid={`pattern-row-edit-panel-${pattern.id}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.55rem",
            paddingTop: "0.4rem",
            borderTop: "1px dashed var(--wp-border, var(--wp-dark-border))",
          }}
        >
          <div
            style={{
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
              lineHeight: 1.45,
            }}
          >
            This template is the STARTING POINT for AI auto-acknowledgements.
            The AI will rephrase it to match the customer&apos;s specific wording.
            NEVER include claims about user state (e.g. &quot;your account is
            locked&quot;). Only general self-serve steps the user can safely try.
          </div>

          <details
            data-testid={`pattern-row-sample-${pattern.id}`}
            style={{
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                color: "rgb(140,185,235)",
                fontWeight: 500,
              }}
            >
              See a good example
            </summary>
            <pre
              style={{
                marginTop: "0.4rem",
                padding: "0.55rem 0.7rem",
                background: "rgba(82,154,232,0.08)",
                border: "1px solid rgba(82,154,232,0.25)",
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: "0.78rem",
                color: "var(--wp-text)",
              }}
            >
              {SAMPLE_TEMPLATE}
            </pre>
          </details>

          <label
            htmlFor={`pattern-row-template-${pattern.id}`}
            style={{
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--wp-text)",
            }}
          >
            Auto-ack template
          </label>
          <textarea
            id={`pattern-row-template-${pattern.id}`}
            data-testid={`pattern-row-template-${pattern.id}`}
            value={templateDraft}
            onChange={(e) => setTemplateDraft(e.target.value)}
            rows={6}
            placeholder="Leave empty to fall back to the pattern's draft_template."
            style={{
              width: "100%",
              minHeight: 120,
              padding: "0.6rem 0.7rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: "0.86rem",
              lineHeight: 1.45,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              data-testid={`pattern-row-save-template-${pattern.id}`}
              disabled={!dirty || savingField === "template"}
              onClick={onSaveTemplate}
              style={{
                background: dirty ? "var(--wp-gold)" : "rgba(160,168,180,0.25)",
                color: dirty ? "var(--wp-dark)" : "var(--wp-text-dim)",
                border: "none",
                padding: "0.5rem 1rem",
                borderRadius: 6,
                fontSize: "0.85rem",
                fontWeight: 600,
                cursor: dirty && savingField !== "template" ? "pointer" : "default",
              }}
            >
              {savingField === "template"
                ? "Saving…"
                : savedField === "template"
                  ? "Saved"
                  : "Save template"}
            </button>
            {dirty ? (
              <span
                style={{ fontSize: "0.78rem", color: "var(--wp-text-dim)" }}
              >
                Unsaved changes
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

interface ToggleButtonProps {
  testId: string;
  label: string;
  on: boolean;
  saving: boolean;
  saved: boolean;
  onClick: () => void;
}

function ToggleButton({
  testId,
  label,
  on,
  saving,
  saved,
  onClick,
}: ToggleButtonProps) {
  /* On = green; off = muted gray. The "saved" pulse softens the green
     so the operator sees positive feedback without a layout shift. */
  const onBg = saved ? "rgba(80,175,110,0.32)" : "rgba(80,175,110,0.18)";
  const onBorder = "rgba(80,175,110,0.6)";
  const onText = "rgb(120,210,150)";
  const offBg = "rgba(160,168,180,0.18)";
  const offBorder = "rgba(160,168,180,0.45)";
  const offText = "rgb(180,186,195)";

  return (
    <button
      type="button"
      data-testid={testId}
      data-on={on ? "true" : "false"}
      data-saving={saving ? "true" : "false"}
      data-saved={saved ? "true" : "false"}
      role="switch"
      aria-checked={on}
      aria-label={`${label}: ${on ? "on" : "off"}`}
      disabled={saving}
      onClick={onClick}
      style={{
        background: on ? onBg : offBg,
        color: on ? onText : offText,
        border: `1px solid ${on ? onBorder : offBorder}`,
        padding: "0.4rem 0.85rem",
        borderRadius: 999,
        fontSize: "0.8rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        cursor: saving ? "default" : "pointer",
        whiteSpace: "nowrap",
        transition: "background 0.18s ease, border-color 0.18s ease",
      }}
    >
      {label}: {saving ? "…" : on ? "on" : "off"}
    </button>
  );
}

async function safeError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j === "object" && typeof j.error === "string") {
      return `Save failed (${res.status}): ${j.error}`;
    }
  } catch {
    /* fall through */
  }
  return `Save failed with status ${res.status}.`;
}

const SAMPLE_TEMPLATE = `Hi {{first_name}},

Thanks for reaching out. The error you ran into usually clears up with one of the steps below. Please try them in order and let us know which one resolves it.

1. Sign out everywhere and try again from a fresh InPrivate or Incognito window.
2. Confirm the time on your computer is correct (within a few minutes of real time).
3. Restart the affected app fully (close it from the system tray, then reopen).

If you still see the error after those, reply to this email and a teammate will pick it up.

The Wolfpack Team`;
