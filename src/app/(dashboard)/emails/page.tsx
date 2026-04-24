"use client";

/**
 * /emails — Inline email composer designed to replace browser Outlook
 * for everyday sends. Three-pane layout:
 *
 *   [ Templates sidebar ]  [ Composer (main) ]  [ Recipient insights ]
 *
 * - Templates collapse to a top "Insert template ▾" dropdown on narrow
 *   screens so the composer stays primary.
 * - The composer always renders inline — never a modal/drawer. CC/BCC
 *   sections are togglable via × buttons (chips keep their own ×).
 * - Recipient insights panel fetches recent threads with the first To:
 *   recipient (GET /api/microsoft?action=emails-from) and the last past
 *   meeting with them (GET /api/calendar/range?view=month, then
 *   client-side attendee filter).
 * - Send wires through POST /api/mail/send.
 * - AI draft via POST /api/assistant/draft-reply (surface: "email").
 * - Draft persistence: sessionStorage key `mail.compose.draft`.
 * - All authenticated fetches go through fetchWithRefresh.
 * - All actions emit through emitInsight().
 *
 * Honours the dashboard chrome: page itself does not scroll
 * (height:100% + overflow:hidden); inner sections scroll.
 *
 * v1 limitations:
 *   - Body is a plain <textarea> (not contentEditable rich text).
 *   - "AI summary of past correspondence" is a heuristic preview built
 *     from the first thread snippet, not a fresh LLM call. Wiring a
 *     dedicated /api/assistant/summarize-thread is a follow-up.
 *   - Insights panel only inspects the first To: recipient.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctUser,
} from "@/lib/client-auth";
import { emitInsight } from "@/lib/insights/emit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  requiredVariables: string[];
  optionalVariables: string[];
}

interface DraftState {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

interface RecentEmail {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
}

interface CalendarEventLite {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  attendeeEmails: string[];
}

interface InsightsState {
  loading: boolean;
  recipient: string | null;
  recentThreads: RecentEmail[];
  lastMeeting: CalendarEventLite | null;
  summary: string;
  error: string | null;
}

interface AuthedUser {
  id: string;
  role: string;
  name?: string;
  email?: string;
}

const DRAFT_KEY = "mail.compose.draft";
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Draft persistence (sessionStorage)
// ---------------------------------------------------------------------------

function emptyDraft(): DraftState {
  return { to: [], cc: [], bcc: [], subject: "", body: "" };
}

function loadDraft(): DraftState {
  if (typeof window === "undefined") return emptyDraft();
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const p = JSON.parse(raw) as Partial<DraftState>;
    return {
      to: Array.isArray(p.to) ? p.to : [],
      cc: Array.isArray(p.cc) ? p.cc : [],
      bcc: Array.isArray(p.bcc) ? p.bcc : [],
      subject: typeof p.subject === "string" ? p.subject : "",
      body: typeof p.body === "string" ? p.body : "",
    };
  } catch {
    return emptyDraft();
  }
}

function saveDraft(d: DraftState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
}

function isPlausibleEmail(s: string): boolean {
  return EMAIL_RX.test(s.trim());
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function daysAgo(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / (1000 * 60 * 60 * 24)));
}

function formatRelative(iso: string): string {
  const d = daysAgo(iso);
  if (d < 0) return "—";
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 30) return `${d} days ago`;
  const months = Math.round(d / 30);
  return months <= 1 ? "1 month ago" : `${months} months ago`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(true);

  const [draft, setDraft] = useState<DraftState>(() => loadDraft());
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [bccInput, setBccInput] = useState("");
  const [showCc, setShowCc] = useState<boolean>(() => loadDraft().cc.length > 0);
  const [showBcc, setShowBcc] = useState<boolean>(() => loadDraft().bcc.length > 0);

  const [busy, setBusy] = useState(false);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [insights, setInsights] = useState<InsightsState>({
    loading: false,
    recipient: null,
    recentThreads: [],
    lastMeeting: null,
    summary: "",
    error: null,
  });

  const mountedRef = useRef(false);
  const insightsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const user = useMemo<AuthedUser>(() => {
    const u = getInstinctUser<AuthedUser>();
    return u ?? { id: "anon", role: "user" };
  }, []);

  // -------------------------------------------------------------------------
  // Mount: load templates + emit compose_opened
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "compose_opened",
      tier: "personal",
      payload: {},
    });

    (async () => {
      setTemplatesLoading(true);
      try {
        const res = await fetchWithRefresh("/api/emails", {
          headers: jsonHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setTemplates(Array.isArray(data.templates) ? data.templates : []);
        }
      } catch {
        /* templates are optional — composer still works */
      } finally {
        setTemplatesLoading(false);
      }
    })();
  }, [user.id, user.role]);

  // -------------------------------------------------------------------------
  // Draft persistence
  // -------------------------------------------------------------------------

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  // -------------------------------------------------------------------------
  // Insights load (debounced) — first To: recipient drives the panel
  // -------------------------------------------------------------------------

  const firstRecipient = draft.to[0] ?? null;

  const loadInsights = useCallback(
    async (recipient: string) => {
      setInsights((s) => ({ ...s, loading: true, recipient, error: null }));

      let recentThreads: RecentEmail[] = [];
      let lastMeeting: CalendarEventLite | null = null;
      let summary = "";

      try {
        const res = await fetchWithRefresh(
          `/api/microsoft?action=emails-from&email=${encodeURIComponent(recipient)}`,
          { headers: jsonHeaders() },
        );
        if (res.ok) {
          const data = await res.json();
          recentThreads = Array.isArray(data.emails) ? data.emails.slice(0, 5) : [];
          if (recentThreads[0]?.bodyPreview) {
            summary = recentThreads[0].bodyPreview.slice(0, 280);
          }
        }
      } catch {
        /* tolerate — insights are best-effort */
      }

      try {
        const res = await fetchWithRefresh(
          "/api/calendar/range?view=month",
          { headers: jsonHeaders() },
        );
        if (res.ok) {
          const data = await res.json();
          const events: CalendarEventLite[] = Array.isArray(data.events) ? data.events : [];
          const recipientLower = recipient.toLowerCase();
          const past = events
            .filter((ev) => {
              const emails = (ev.attendeeEmails ?? []).map((e) => e.toLowerCase());
              if (!emails.includes(recipientLower)) return false;
              const startMs = Date.parse(ev.start);
              return !Number.isNaN(startMs) && startMs <= Date.now();
            })
            .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
          lastMeeting = past[0] ?? null;
        }
      } catch {
        /* tolerate */
      }

      const lastMeetingDays = lastMeeting ? daysAgo(lastMeeting.start) : -1;

      setInsights({
        loading: false,
        recipient,
        recentThreads,
        lastMeeting,
        summary,
        error: null,
      });

      emitInsight({
        actor: user.id,
        role: user.role,
        surface: "email",
        action: "insights_loaded",
        tier: "personal",
        payload: {
          recipient,
          recent_thread_count: recentThreads.length,
          last_meeting_days_ago: lastMeetingDays,
        },
      });
    },
    [user.id, user.role],
  );

  useEffect(() => {
    if (insightsTimerRef.current) {
      clearTimeout(insightsTimerRef.current);
      insightsTimerRef.current = null;
    }
    if (!firstRecipient) {
      setInsights({
        loading: false,
        recipient: null,
        recentThreads: [],
        lastMeeting: null,
        summary: "",
        error: null,
      });
      return;
    }
    // Debounce — chip add fires synchronously, but we still want to
    // coalesce rapid edits.
    insightsTimerRef.current = setTimeout(() => {
      void loadInsights(firstRecipient);
    }, 50);
    return () => {
      if (insightsTimerRef.current) {
        clearTimeout(insightsTimerRef.current);
        insightsTimerRef.current = null;
      }
    };
  }, [firstRecipient, loadInsights]);

  // -------------------------------------------------------------------------
  // Chip handling
  // -------------------------------------------------------------------------

  function addChip(field: "to" | "cc" | "bcc", value: string) {
    const v = value.trim().replace(/[,;]$/, "").trim();
    if (!v) return;
    if (!isPlausibleEmail(v)) {
      setError(`"${v}" doesn't look like an email address`);
      return;
    }
    setError(null);
    setDraft((prev) => {
      if (prev[field].includes(v)) return prev;
      const next = { ...prev, [field]: [...prev[field], v] } as DraftState;
      return next;
    });
    if (field === "to") {
      emitInsight({
        actor: user.id,
        role: user.role,
        surface: "email",
        action: "recipient_set",
        tier: "org",
        target: v,
        payload: {},
      });
    }
  }

  function removeChip(field: "to" | "cc" | "bcc", value: string) {
    setDraft((prev) => ({
      ...prev,
      [field]: prev[field].filter((x) => x !== value),
    }));
  }

  function handleChipKey(
    field: "to" | "cc" | "bcc",
    input: string,
    setInput: (s: string) => void,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
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

  // -------------------------------------------------------------------------
  // Template insertion
  // -------------------------------------------------------------------------

  function applyTemplate(t: EmailTemplate) {
    // Use the template's name as the subject and a scaffold body listing
    // its variables — non-LLM, zero-token, immediately editable.
    const variableLines = [
      ...t.requiredVariables.map((v) => `${v}: `),
      ...t.optionalVariables.map((v) => `${v} (optional): `),
    ].join("\n");
    const body = `${t.description}\n\n${variableLines}`.trim();
    setDraft((prev) => ({ ...prev, subject: t.name, body }));
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "template_inserted",
      tier: "personal",
      target: t.id,
      payload: {},
    });
  }

  // -------------------------------------------------------------------------
  // AI draft
  // -------------------------------------------------------------------------

  async function requestAiDraft() {
    if (aiDrafting) return;
    setAiDrafting(true);
    setError(null);
    try {
      const recipientName = draft.to[0] ?? "";
      const res = await fetchWithRefresh("/api/assistant/draft-reply", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          surface: "email",
          recipientName,
          threadContext: draft.subject
            ? [{ from: "Subject", text: draft.subject }]
            : [],
          draftSoFar: draft.body,
        }),
      });
      if (!res.ok) {
        setError("Couldn't draft a reply. Try again.");
        return;
      }
      const data = (await res.json()) as { text?: string };
      const suggested = (data.text ?? "").trim();
      if (suggested) {
        setDraft((prev) => ({ ...prev, body: suggested }));
      }
    } catch {
      setError("Couldn't draft a reply. Try again.");
    } finally {
      setAiDrafting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  function canSend(): boolean {
    if (busy) return false;
    if (draft.to.length === 0) return false;
    if (!draft.subject.trim()) return false;
    if (!draft.body.trim()) return false;
    return true;
  }

  async function send() {
    if (!canSend()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);

    const bodyText = draft.body;
    const bodyHtml = bodyText
      .split("\n")
      .map((l) =>
        l.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)),
      )
      .join("<br>");

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
          setError(
            `Microsoft is missing the ${data.scope ?? "Mail.Send"} scope. Reconnect in Settings > Integrations.`,
          );
        } else if (res.status === 429) {
          const ra = data?.retryAfter ?? 60;
          setError(`Too many emails sent recently. Try again in ${ra}s.`);
        } else if (res.status === 401) {
          setError(
            data?.error === "microsoft_not_connected"
              ? "Microsoft isn't connected. Settings > Integrations to link your account."
              : "Your session expired. Sign in again.",
          );
        } else {
          setError(data?.detail || data?.error || "Send failed");
        }
        return;
      }

      setSuccess("Sent");
      clearDraft();
      setDraft(emptyDraft());
      setShowCc(false);
      setShowBcc(false);
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Discard
  // -------------------------------------------------------------------------

  function discard() {
    clearDraft();
    setDraft(emptyDraft());
    setShowCc(false);
    setShowBcc(false);
    setError(null);
    setSuccess(null);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={pageWrap} data-testid="emails-page">
      {/* Templates sidebar */}
      <aside
        style={{
          ...sidebarStyle,
          width: templatesOpen ? "260px" : "44px",
        }}
        aria-label="Email templates"
      >
        <div style={sidebarHeader}>
          {templatesOpen ? (
            <>
              <span style={{ color: "var(--wp-gold)", fontWeight: 600, fontSize: "0.85rem" }}>
                Templates
              </span>
              <button
                type="button"
                onClick={() => setTemplatesOpen(false)}
                aria-label="Collapse templates"
                style={iconBtn}
              >
                ‹
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setTemplatesOpen(true)}
              aria-label="Expand templates"
              style={{ ...iconBtn, margin: "0 auto" }}
            >
              ›
            </button>
          )}
        </div>
        {templatesOpen && (
          <div style={sidebarBody}>
            {templatesLoading ? (
              <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
                Loading…
              </p>
            ) : templates.length === 0 ? (
              <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
                No templates available
              </p>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`template-${t.id}`}
                  onClick={() => applyTemplate(t)}
                  style={templateBtn}
                >
                  <span style={{ fontWeight: 600, fontSize: "0.82rem", color: "var(--wp-text)" }}>
                    {t.name}
                  </span>
                  <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)", marginTop: "2px" }}>
                    {t.description}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </aside>

      {/* Composer (main) */}
      <section
        style={composerWrap}
        data-testid="composer-wrap"
        aria-label="Email composer"
      >
        <header style={composerHeader}>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-gold)", margin: 0 }}>
            New email
          </h1>
          <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim)" }}>
            Drafts auto-save
          </span>
        </header>

        <div style={composerBody}>
          <ChipField
            label="To"
            field="to"
            chips={draft.to}
            input={toInput}
            setInput={setToInput}
            onKey={(e) => handleChipKey("to", toInput, setToInput, e)}
            onRemove={(v) => removeChip("to", v)}
            onBlurCommit={() => {
              if (toInput.trim()) {
                addChip("to", toInput);
                setToInput("");
              }
            }}
          />

          {!showCc ? (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              style={linkBtn}
              data-testid="add-cc"
            >
              Add CC
            </button>
          ) : (
            <ChipFieldWithClose
              label="CC"
              field="cc"
              chips={draft.cc}
              input={ccInput}
              setInput={setCcInput}
              onKey={(e) => handleChipKey("cc", ccInput, setCcInput, e)}
              onRemove={(v) => removeChip("cc", v)}
              onClose={() => {
                setShowCc(false);
                setDraft((prev) => ({ ...prev, cc: [] }));
                setCcInput("");
              }}
              onBlurCommit={() => {
                if (ccInput.trim()) {
                  addChip("cc", ccInput);
                  setCcInput("");
                }
              }}
            />
          )}

          {!showBcc ? (
            <button
              type="button"
              onClick={() => setShowBcc(true)}
              style={linkBtn}
              data-testid="add-bcc"
            >
              Add BCC
            </button>
          ) : (
            <ChipFieldWithClose
              label="BCC"
              field="bcc"
              chips={draft.bcc}
              input={bccInput}
              setInput={setBccInput}
              onKey={(e) => handleChipKey("bcc", bccInput, setBccInput, e)}
              onRemove={(v) => removeChip("bcc", v)}
              onClose={() => {
                setShowBcc(false);
                setDraft((prev) => ({ ...prev, bcc: [] }));
                setBccInput("");
              }}
              onBlurCommit={() => {
                if (bccInput.trim()) {
                  addChip("bcc", bccInput);
                  setBccInput("");
                }
              }}
            />
          )}

          <label style={fieldLabel}>
            <span style={fieldLabelText}>Subject</span>
            <input
              type="text"
              value={draft.subject}
              onChange={(e) => setDraft((prev) => ({ ...prev, subject: e.target.value }))}
              placeholder="Subject"
              aria-label="Subject"
              style={textInput}
            />
          </label>

          <label style={{ ...fieldLabel, flex: 1, minHeight: 0 }}>
            <span style={fieldLabelText}>Body</span>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft((prev) => ({ ...prev, body: e.target.value }))}
              aria-label="Email body"
              data-testid="compose-body"
              placeholder="Write your message…"
              style={bodyTextarea}
            />
          </label>

          {error && (
            <div role="alert" style={errorBox}>
              {error}
            </div>
          )}
          {success && (
            <div role="status" style={successBox}>
              {success}
            </div>
          )}

          <div style={actionsRow}>
            <button type="button" onClick={discard} style={btn()}>
              Discard
            </button>
            <button
              type="button"
              onClick={requestAiDraft}
              disabled={aiDrafting}
              data-testid="ai-draft-btn"
              style={{ ...btn(), color: "var(--wp-gold)" }}
            >
              {aiDrafting ? "Drafting…" : "✨ AI Draft"}
            </button>
            <button
              type="button"
              onClick={send}
              disabled={!canSend()}
              data-testid="compose-send"
              style={{
                ...btn("var(--wp-gold)"),
                opacity: canSend() ? 1 : 0.5,
                cursor: canSend() ? "pointer" : "not-allowed",
              }}
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </section>

      {/* Recipient insights */}
      <aside style={insightsWrap} aria-label="Recipient insights" data-testid="insights-panel">
        <header style={insightsHeader}>
          <span style={{ color: "var(--wp-gold)", fontWeight: 600, fontSize: "0.85rem" }}>
            Recipient context
          </span>
        </header>
        <div style={insightsBody}>
          {!firstRecipient ? (
            <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Add a To: recipient to see recent threads, last meeting, and an
              AI-summary of past correspondence.
            </p>
          ) : insights.loading ? (
            <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Loading insights for {firstRecipient}…
            </p>
          ) : (
            <>
              <div style={insightCell} data-testid="insight-recipient">
                <span style={cellLabel}>Recipient</span>
                <span style={cellValue}>{firstRecipient}</span>
              </div>

              <div style={insightCell} data-testid="insight-recent-threads">
                <span style={cellLabel}>
                  Recent threads ({insights.recentThreads.length})
                </span>
                {insights.recentThreads.length === 0 ? (
                  <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
                    No prior emails found.
                  </span>
                ) : (
                  <ul style={threadList}>
                    {insights.recentThreads.map((t) => (
                      <li key={t.id} style={threadItem}>
                        <span style={threadSubject}>{t.subject || "(no subject)"}</span>
                        <span style={threadMeta}>
                          {formatRelative(t.receivedDateTime)} · {t.from}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div style={insightCell} data-testid="insight-last-meeting">
                <span style={cellLabel}>Last meeting</span>
                {insights.lastMeeting ? (
                  <>
                    <span style={cellValue}>{insights.lastMeeting.subject}</span>
                    <span style={{ ...cellValue, color: "var(--wp-text-dim)", fontSize: "0.75rem" }}>
                      {formatRelative(insights.lastMeeting.start)}
                    </span>
                  </>
                ) : (
                  <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
                    No past meeting in the last month.
                  </span>
                )}
              </div>

              {insights.summary && (
                <div style={insightCell} data-testid="insight-summary">
                  <span style={cellLabel}>Last message preview</span>
                  <span style={{ ...cellValue, color: "var(--wp-text-dim)", fontSize: "0.78rem" }}>
                    {insights.summary}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChipField subcomponents
// ---------------------------------------------------------------------------

interface ChipFieldProps {
  label: string;
  field: "to" | "cc" | "bcc";
  chips: string[];
  input: string;
  setInput: (s: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRemove: (v: string) => void;
  onBlurCommit?: () => void;
}

function ChipField(p: ChipFieldProps) {
  return (
    <label style={fieldLabel} data-field={p.field}>
      <span style={fieldLabelText}>{p.label}</span>
      <div style={chipWrap}>
        {p.chips.map((c) => (
          <span key={c} style={chipStyle}>
            {c}
            <button
              type="button"
              aria-label={`Remove ${c}`}
              onClick={() => p.onRemove(c)}
              style={chipRemoveBtn}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label={`${p.label} email input`}
          value={p.input}
          onChange={(e) => p.setInput(e.target.value)}
          onKeyDown={p.onKey}
          onBlur={() => p.onBlurCommit?.()}
          placeholder="email@example.com"
          style={chipInput}
        />
      </div>
    </label>
  );
}

interface ChipFieldWithCloseProps extends ChipFieldProps {
  onClose: () => void;
}

function ChipFieldWithClose(p: ChipFieldWithCloseProps) {
  return (
    <div data-field={p.field} style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={fieldLabelText}>{p.label}</span>
        <button
          type="button"
          aria-label={`Hide ${p.label} field`}
          data-testid={`hide-${p.field}`}
          onClick={p.onClose}
          style={iconBtn}
        >
          ×
        </button>
      </div>
      <div style={chipWrap}>
        {p.chips.map((c) => (
          <span key={c} style={chipStyle}>
            {c}
            <button
              type="button"
              aria-label={`Remove ${c}`}
              onClick={() => p.onRemove(c)}
              style={chipRemoveBtn}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label={`${p.label} email input`}
          value={p.input}
          onChange={(e) => p.setInput(e.target.value)}
          onKeyDown={p.onKey}
          onBlur={() => p.onBlurCommit?.()}
          placeholder="email@example.com"
          style={chipInput}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — opaque var(--wp-*) only.
// ---------------------------------------------------------------------------

const pageWrap: React.CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "row",
  gap: "0.75rem",
  padding: "0.75rem",
  background: "var(--wp-dark)",
  overflow: "hidden",
  boxSizing: "border-box",
  flexWrap: "wrap",
};

const sidebarStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  flexShrink: 0,
  transition: "width 120ms ease",
};

const sidebarHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  background: "var(--wp-dark-surface2)",
};

const sidebarBody: React.CSSProperties = {
  padding: "0.5rem",
  display: "grid",
  gap: "0.4rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const templateBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "6px",
  color: "var(--wp-text)",
  cursor: "pointer",
  fontSize: "0.82rem",
};

const composerWrap: React.CSSProperties = {
  flex: "1 1 480px",
  minWidth: "320px",
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const composerHeader: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.6rem 0.9rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  background: "var(--wp-dark-surface2)",
};

const composerBody: React.CSSProperties = {
  padding: "0.85rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.7rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const fieldLabel: React.CSSProperties = { display: "grid", gap: "0.25rem" };
const fieldLabelText: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--wp-text-dim)",
  fontWeight: 500,
};

const textInput: React.CSSProperties = {
  padding: "0.5rem 0.7rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.88rem",
  outline: "none",
};

const bodyTextarea: React.CSSProperties = {
  padding: "0.65rem 0.75rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.88rem",
  minHeight: "180px",
  resize: "vertical",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
  flex: 1,
};

const chipWrap: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.3rem",
  padding: "0.3rem 0.4rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "5px",
  minHeight: "38px",
  alignItems: "center",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  background: "var(--wp-dark-surface2)",
  padding: "0.18rem 0.45rem",
  borderRadius: "999px",
  fontSize: "0.78rem",
  color: "var(--wp-text)",
};

const chipRemoveBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-dim)",
  cursor: "pointer",
  fontSize: "0.95rem",
  lineHeight: 1,
  padding: 0,
};

const chipInput: React.CSSProperties = {
  flex: 1,
  minWidth: "120px",
  border: "none",
  background: "transparent",
  color: "var(--wp-text)",
  fontSize: "0.85rem",
  padding: "0.25rem 0.3rem",
  outline: "none",
};

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-dim)",
  cursor: "pointer",
  fontSize: "1rem",
  padding: "0.1rem 0.4rem",
  lineHeight: 1,
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-gold)",
  cursor: "pointer",
  fontSize: "0.78rem",
  textAlign: "left",
  padding: 0,
  alignSelf: "flex-start",
};

const errorBox: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid #ff7878",
  borderRadius: "5px",
  color: "#ff7878",
  fontSize: "0.82rem",
};

const successBox: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid #5fd38f",
  borderRadius: "5px",
  color: "#5fd38f",
  fontSize: "0.82rem",
};

const actionsRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

function btn(bg = "var(--wp-dark-surface2)"): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: bg,
    color: bg === "var(--wp-gold)" ? "var(--wp-dark)" : "var(--wp-text)",
    border: "1px solid var(--wp-dark-border)",
    borderRadius: "5px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.82rem",
  };
}

const insightsWrap: React.CSSProperties = {
  width: "320px",
  flexShrink: 0,
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const insightsHeader: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  background: "var(--wp-dark-surface2)",
};

const insightsBody: React.CSSProperties = {
  padding: "0.65rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const insightCell: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.5rem 0.6rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "6px",
};

const cellLabel: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--wp-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const cellValue: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--wp-text)",
  wordBreak: "break-word",
};

const threadList: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const threadItem: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const threadSubject: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--wp-text)",
};

const threadMeta: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--wp-text-dim)",
};
