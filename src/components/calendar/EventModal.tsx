"use client";

/**
 * EventModal — centered modal for creating a calendar event.
 * Wires to POST /api/calendar/events. Close on success or cancel.
 *
 * Tier 2 hook: the Online Meeting toggle is rendered disabled with a
 * tooltip. When Stream C flips the Teams scope on, removing the
 * `disabled` attribute is the only UI change needed.
 */

import { useEffect, useState } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

export interface EventModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string, webLink: string | null) => void;
  initialStart?: string;
  initialEnd?: string;
}

function toLocalInputValue(iso: string | undefined): string {
  if (!iso) {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return toDatetimeLocal(d);
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return toDatetimeLocal(d);
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(v: string): string {
  if (!v) return "";
  // Treat input as local — convert to UTC ISO
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function EventModal({ open, onClose, onCreated, initialStart, initialEnd }: EventModalProps) {
  const [subject, setSubject] = useState("");
  const [start, setStart] = useState<string>(() => toLocalInputValue(initialStart));
  const [end, setEnd] = useState<string>(() => {
    if (initialEnd) return toLocalInputValue(initialEnd);
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 2);
    return toDatetimeLocal(d);
  });
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [online, setOnline] = useState(false); // disabled — tooltip explains
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  function addAttendee(value: string) {
    const v = value.trim().replace(/[,;]$/, "").trim();
    if (!v) return;
    if (!isPlausibleEmail(v)) {
      setError(`"${v}" doesn't look like an email address`);
      return;
    }
    setError(null);
    setAttendees((prev) => Array.from(new Set([...prev, v])));
  }

  function removeAttendee(v: string) {
    setAttendees((prev) => prev.filter((x) => x !== v));
  }

  function canSubmit(): boolean {
    if (busy) return false;
    if (!subject.trim()) return false;
    const s = fromDatetimeLocal(start);
    const e = fromDatetimeLocal(end);
    if (!s || !e) return false;
    if (new Date(e).getTime() <= new Date(s).getTime()) return false;
    return true;
  }

  async function submit() {
    if (!canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/calendar/events", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          subject: subject.trim(),
          start: fromDatetimeLocal(start),
          end: fromDatetimeLocal(end),
          attendees,
          location: location.trim() || undefined,
          bodyText: notes || undefined,
          isOnlineMeeting: false, // Tier 2 — see tooltip
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 && data?.code === "scope_missing") {
          setError(`Microsoft is missing the ${data.scope ?? "Calendars.ReadWrite"} scope. Reconnect in Settings > Integrations.`);
        } else if (res.status === 429) {
          setError(`Too many calendar changes recently. Try again in ${data?.retryAfter ?? 60}s.`);
        } else if (res.status === 401) {
          setError(data?.error === "microsoft_not_connected"
            ? "Microsoft isn't connected."
            : "Your session expired.");
        } else {
          setError(data?.detail || data?.error || "Failed to create event");
        }
        return;
      }
      onCreated?.(data.id, data.webLink ?? null);
      resetAndClose();
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  function resetAndClose() {
    setSubject("");
    setAttendees([]);
    setAttendeeInput("");
    setLocation("");
    setNotes("");
    setOnline(false);
    onClose();
  }

  if (!open) return null;

  return (
    <div data-testid="event-modal" role="dialog" aria-label="Create event" style={overlayStyle} onClick={resetAndClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>New event</strong>
          <button aria-label="Close" onClick={resetAndClose} style={iconBtnStyle}>×</button>
        </div>

        <div style={bodyStyle}>
          <label style={labelStyle}>
            <span style={labelText}>Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              aria-label="Subject"
              style={inputStyle}
            />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
            <label style={labelStyle}>
              <span style={labelText}>Start</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="Start"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <span style={labelText}>End</span>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                aria-label="End"
                style={inputStyle}
              />
            </label>
          </div>

          <label style={labelStyle}>
            <span style={labelText}>Attendees</span>
            <div style={chipWrap}>
              {attendees.map((a) => (
                <span key={a} style={chipStyle}>
                  {a}
                  <button
                    type="button"
                    aria-label={`Remove ${a}`}
                    onClick={() => removeAttendee(a)}
                    style={chipRemoveStyle}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                aria-label="Attendee email input"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                    if (attendeeInput.trim().length > 0) {
                      e.preventDefault();
                      addAttendee(attendeeInput);
                      setAttendeeInput("");
                    }
                  }
                }}
                placeholder="email@example.com"
                style={chipInputStyle}
              />
            </div>
          </label>

          <label style={labelStyle}>
            <span style={labelText}>Location</span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Room, address, or URL"
              aria-label="Location"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
            <span style={labelText}>Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Agenda, prep notes, etc."
              aria-label="Notes"
              rows={3}
              style={{ ...inputStyle, resize: "vertical", minHeight: "70px" }}
            />
          </label>

          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", opacity: 0.6 }}
            title="Available after Teams scope is granted"
            data-testid="online-meeting-label"
          >
            <input
              type="checkbox"
              checked={online}
              disabled
              onChange={(e) => setOnline(e.target.checked)}
              aria-label="Online meeting"
              data-testid="online-meeting-toggle"
            />
            <span>Online meeting (Teams) <em style={{ fontSize: "0.75rem" }}>— Available after Teams scope is granted</em></span>
          </label>

          {error && <div role="alert" style={errorStyle}>{error}</div>}

          <div style={actionsStyle}>
            <button type="button" onClick={resetAndClose} style={btn()}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="event-submit"
              disabled={!canSubmit()}
              onClick={submit}
              style={{ ...btn("var(--wp-gold)"), opacity: canSubmit() ? 1 : 0.5, cursor: canSubmit() ? "pointer" : "not-allowed" }}
            >
              {busy ? "Creating..." : "Create event"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 1000,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
};
const modalStyle: React.CSSProperties = {
  width: "min(560px, 94vw)",
  maxHeight: "90vh",
  background: "var(--wp-card)",
  border: "1px solid var(--wp-border)",
  borderRadius: "10px",
  boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
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
};
const bodyStyle: React.CSSProperties = {
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
const errorStyle: React.CSSProperties = { color: "#ff7878", fontSize: "0.85rem" };
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
