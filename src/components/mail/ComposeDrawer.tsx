"use client";

/**
 * ComposeDrawer — right-side slide-in email composer wired to
 * POST /api/mail/send.
 *
 * Fields: To/CC/BCC (chip inputs, plain email validation — TODO swap for
 * People autocomplete from Stream B), Subject, Body (contentEditable —
 * no rich-text library). The draft persists to sessionStorage so a tab
 * reload doesn't discard work.
 *
 * Errors:
 *   scope_missing → explicit "Microsoft is missing Mail.Send scope. Reconnect."
 *   rate_limited  → "Too many emails sent recently. Try again in Ns."
 *   everything else → surfaced verbatim with generic fallback.
 */

import { useEffect, useRef, useState } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

const DRAFT_KEY = "instinct.mail.compose.draft.v1";

interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string; // inner HTML, stripped to text on send if no HTML wanted
}

function emptyDraft(): Draft {
  return { to: [], cc: [], bcc: [], subject: "", body: "" };
}

function loadDraft(): Draft {
  if (typeof window === "undefined") return emptyDraft();
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      to: Array.isArray(parsed.to) ? parsed.to : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc : [],
      bcc: Array.isArray(parsed.bcc) ? parsed.bcc : [],
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return emptyDraft();
  }
}

function saveDraft(d: Draft): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // quota / private mode — silently ignore
  }
}

function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
}

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export interface ComposeDrawerProps {
  open: boolean;
  onClose: () => void;
  onSent?: (id: string) => void;
  /** Prefill "to" list (e.g. "reply to this client") */
  initialTo?: string[];
  initialSubject?: string;
}

export function ComposeDrawer({ open, onClose, onSent, initialTo, initialSubject }: ComposeDrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft());
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [bccInput, setBccInput] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Only merge initials on open — don't stomp the user's manual edits
    setDraft((prev) => ({
      ...prev,
      to: prev.to.length > 0 ? prev.to : initialTo ?? [],
      subject: prev.subject || initialSubject || "",
    }));
  }, [open, initialTo, initialSubject]);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  function addChip(field: "to" | "cc" | "bcc", value: string) {
    const v = value.trim().replace(/[,;]$/, "").trim();
    if (!v) return;
    if (!isPlausibleEmail(v)) {
      setError(`"${v}" doesn't look like an email address`);
      return;
    }
    setError(null);
    setDraft((prev) => ({ ...prev, [field]: Array.from(new Set([...prev[field], v])) } as Draft));
  }
  function removeChip(field: "to" | "cc" | "bcc", value: string) {
    setDraft((prev) => ({ ...prev, [field]: prev[field].filter((x) => x !== value) } as Draft));
  }

  function handleKey(field: "to" | "cc" | "bcc", input: string, setInput: (s: string) => void, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (input.trim().length > 0) {
        e.preventDefault();
        addChip(field, input);
        setInput("");
      }
    } else if (e.key === "Backspace" && input.length === 0) {
      const last = draft[field][draft[field].length - 1];
      if (last) removeChip(field, last);
    }
  }

  function canSend(): boolean {
    if (busy) return false;
    if (draft.to.length === 0) return false;
    if (!draft.subject.trim()) return false;
    const bodyText = (bodyRef.current?.innerText ?? draft.body ?? "").trim();
    if (!bodyText) return false;
    return true;
  }

  async function send() {
    if (!canSend()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);

    const bodyHtml = bodyRef.current?.innerHTML ?? draft.body ?? "";
    const bodyText = bodyRef.current?.innerText ?? "";

    try {
      const res = await fetchWithRefresh("/api/mail/send", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyHtml,
          bodyText,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 && data?.code === "scope_missing") {
          setError(`Microsoft is missing the ${data.scope ?? "Mail.Send"} scope. Please reconnect in Settings > Integrations.`);
        } else if (res.status === 429) {
          const ra = data?.retryAfter ?? 60;
          setError(`Too many emails sent recently. Try again in ${ra}s.`);
        } else if (res.status === 401) {
          setError(data?.error === "microsoft_not_connected"
            ? "Microsoft isn't connected. Settings > Integrations to link your account."
            : "Your session expired. Sign in again.");
        } else {
          setError(data?.detail || data?.error || "Send failed");
        }
        return;
      }

      setSuccess("Sent");
      clearDraft();
      setDraft(emptyDraft());
      if (bodyRef.current) bodyRef.current.innerHTML = "";
      onSent?.(data.id);
      // Auto-close after a short beat
      setTimeout(() => {
        setSuccess(null);
        onClose();
      }, 800);
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div data-testid="compose-drawer" role="dialog" aria-label="Compose email" style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>New email</strong>
          <button onClick={onClose} aria-label="Close compose" style={iconBtnStyle}>
            ×
          </button>
        </div>

        <div style={bodyWrap}>
          <ChipField
            label="To"
            field="to"
            chips={draft.to}
            input={toInput}
            setInput={setToInput}
            onKey={(e) => handleKey("to", toInput, setToInput, e)}
            onRemove={(v) => removeChip("to", v)}
          />

          {!showCc ? (
            <button type="button" onClick={() => setShowCc(true)} style={linkBtnStyle}>Add CC</button>
          ) : (
            <ChipField
              label="CC"
              field="cc"
              chips={draft.cc}
              input={ccInput}
              setInput={setCcInput}
              onKey={(e) => handleKey("cc", ccInput, setCcInput, e)}
              onRemove={(v) => removeChip("cc", v)}
            />
          )}

          {!showBcc ? (
            <button type="button" onClick={() => setShowBcc(true)} style={linkBtnStyle}>Add BCC</button>
          ) : (
            <ChipField
              label="BCC"
              field="bcc"
              chips={draft.bcc}
              input={bccInput}
              setInput={setBccInput}
              onKey={(e) => handleKey("bcc", bccInput, setBccInput, e)}
              onRemove={(v) => removeChip("bcc", v)}
            />
          )}

          <label style={labelStyle}>
            <span style={labelText}>Subject</span>
            <input
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="Subject"
              aria-label="Subject"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
            <span style={labelText}>Body</span>
            <div
              ref={bodyRef}
              contentEditable
              role="textbox"
              aria-label="Email body"
              data-testid="compose-body"
              onInput={() => {
                // Persist rough body text via setDraft so sessionStorage picks it up
                setDraft((prev) => ({ ...prev, body: bodyRef.current?.innerHTML ?? "" }));
              }}
              suppressContentEditableWarning
              style={bodyStyle}
            />
          </label>

          {error && <div role="alert" style={errorStyle}>{error}</div>}
          {success && <div role="status" style={successStyle}>{success}</div>}

          <div style={actionsStyle}>
            <button type="button" onClick={onClose} style={btn()}>
              Discard
            </button>
            <button
              type="button"
              disabled={!canSend()}
              onClick={send}
              data-testid="compose-send"
              style={{ ...btn("var(--wp-gold)"), opacity: canSend() ? 1 : 0.5, cursor: canSend() ? "pointer" : "not-allowed" }}
            >
              {busy ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChipField subcomponent
// ---------------------------------------------------------------------------

interface ChipFieldProps {
  label: string;
  field: "to" | "cc" | "bcc";
  chips: string[];
  input: string;
  setInput: (s: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRemove: (value: string) => void;
}

function ChipField(props: ChipFieldProps) {
  return (
    <label style={labelStyle} data-field={props.field}>
      <span style={labelText}>{props.label}</span>
      <div style={chipWrap}>
        {props.chips.map((c) => (
          <span key={c} style={chipStyle}>
            {c}
            <button
              type="button"
              aria-label={`Remove ${c}`}
              onClick={() => props.onRemove(c)}
              style={chipRemoveStyle}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label={`${props.label} email input`}
          value={props.input}
          onChange={(e) => props.setInput(e.target.value)}
          onKeyDown={props.onKey}
          onBlur={() => {
            if (props.input.trim().length > 0) props.onKey({ key: "Enter", preventDefault: () => {} } as any);
          }}
          placeholder="email@example.com"
          style={chipInputStyle}
        />
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Styles — matches the people module's inline CSS-var pattern.
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 1000,
  display: "flex",
  justifyContent: "flex-end",
};
const drawerStyle: React.CSSProperties = {
  width: "min(540px, 100vw)",
  height: "100%",
  background: "var(--wp-card)",
  borderLeft: "1px solid var(--wp-border)",
  boxShadow: "-4px 0 24px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.75rem 1rem",
  borderBottom: "1px solid var(--wp-border)",
};
const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--wp-text)",
  border: "none",
  fontSize: "1.4rem",
  cursor: "pointer",
  padding: "0 0.5rem",
};
const bodyWrap: React.CSSProperties = {
  padding: "1rem",
  display: "grid",
  gap: "0.75rem",
  overflow: "auto",
};
const labelStyle: React.CSSProperties = { display: "grid", gap: "0.25rem" };
const labelText: React.CSSProperties = { fontSize: "0.8rem", color: "var(--wp-text-secondary)" };
const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.8rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
};
const bodyStyle: React.CSSProperties = {
  minHeight: "160px",
  padding: "0.75rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
  whiteSpace: "pre-wrap",
  outline: "none",
};
const chipWrap: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
  padding: "0.35rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "5px",
  minHeight: "40px",
  alignItems: "center",
};
const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  background: "var(--wp-card)",
  padding: "0.2rem 0.45rem",
  borderRadius: "999px",
  fontSize: "0.8rem",
};
const chipRemoveStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-secondary)",
  cursor: "pointer",
  fontSize: "1rem",
  lineHeight: 1,
  padding: 0,
};
const chipInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: "140px",
  border: "none",
  background: "transparent",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
  padding: "0.3rem 0.4rem",
  outline: "none",
};
const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-gold)",
  cursor: "pointer",
  fontSize: "0.8rem",
  textAlign: "left",
  padding: 0,
};
const errorStyle: React.CSSProperties = { color: "#ff7878", fontSize: "0.85rem" };
const successStyle: React.CSSProperties = { color: "#5fd38f", fontSize: "0.85rem" };
const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

function btn(bg = "var(--wp-card)"): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: bg,
    color: bg === "var(--wp-card)" ? "var(--wp-text)" : "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "5px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.85rem",
  };
}

// Needed so the `authHeaders`/`jsonHeaders` import type-checks even though
// we only use the json variant on the send call.
void authHeaders;
