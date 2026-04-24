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
 * - Body is a contentEditable rich-text div with a tiny toolbar
 *   (Bold/Italic/Underline/UL/OL) wired through document.execCommand.
 *   Send POSTs both bodyHtml + bodyText. Persisted as HTML in
 *   sessionStorage.
 * - Recipient insights panel:
 *     * 1 recipient  → full panel (recent threads + last meeting).
 *     * 2-5 recipients → compact stack of per-recipient cards; click
 *                        a card to expand its full insights inline.
 *     * 6+ recipients → aggregate summary only (earliest last-meeting,
 *                        most-recent thread); per-recipient Graph
 *                        fetches are skipped to protect quota.
 * - Calendar window for "last meeting with recipient" is a year-wide
 *   lookup (view=year), client-cached by recipient email so flipping
 *   between recipients doesn't re-hit the endpoint.
 * - Send wires through POST /api/mail/send.
 * - AI draft via POST /api/assistant/draft-reply (surface: "email").
 *   Model output is HTML-escaped + newlines→<br> before being placed
 *   into the editable body — never trust raw model output as HTML.
 * - Draft persistence: sessionStorage key `mail.compose.draft` (HTML).
 * - All authenticated fetches go through fetchWithRefresh.
 * - All actions emit through emitInsight().
 *
 * Honours the dashboard chrome: page itself does not scroll
 * (height:100% + overflow:hidden); inner sections scroll.
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
  /** HTML body — contentEditable serialized as innerHTML. */
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

interface RecipientInsight {
  loading: boolean;
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
const AGGREGATE_THRESHOLD = 6; // ≥ this many To: → aggregate-only mode
const MULTI_THRESHOLD = 2; // ≥ this and < AGGREGATE_THRESHOLD → per-recipient cards

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function plainTextToHtml(s: string): string {
  return escapeHtml(s).split("\n").join("<br>");
}

function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") {
    // Server-side fallback: strip tags lossy-but-safe.
    return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // jsdom doesn't compute innerText reliably (returns undefined). Fall
  // back to textContent + a <br>→\n shim.
  const text = (tmp as HTMLDivElement).innerText;
  if (typeof text === "string") return text;
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

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
  if (months < 12) return months <= 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.round(d / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  // Responsive breakpoints — narrow = mobile + cramped laptops where the
  // 3-column row layout doesn't fit. We stack vertically and let the
  // page scroll instead of clipping the insights panel.
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < 1100 : false,
  );
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onResize() {
      setIsNarrow(window.innerWidth < 1100);
      setIsMobile(window.innerWidth < 640);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // On mobile the templates rail eats too much space — collapse by
  // default and let the user expand on demand.
  useEffect(() => {
    if (isMobile) setTemplatesOpen(false);
  }, [isMobile]);

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

  // Per-recipient insights cache. Key: recipient email (lowercase).
  const [insightsCache, setInsightsCache] = useState<Record<string, RecipientInsight>>({});
  // Which recipient cards are expanded inline (multi-recipient mode).
  const [expandedRecipients, setExpandedRecipients] = useState<Set<string>>(() => new Set());
  // Calendar fetch is shared across recipients within a single load batch —
  // but we cache the whole event list once per session via this ref.
  const calendarYearCacheRef = useRef<{ events: CalendarEventLite[]; loadedAtMs: number } | null>(null);
  const calendarYearInflightRef = useRef<Promise<CalendarEventLite[]> | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const insightsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const user = useMemo<AuthedUser>(() => {
    const u = getInstinctUser<AuthedUser>();
    return u ?? { id: "anon", role: "user" };
  }, []);

  // -------------------------------------------------------------------------
  // Mount: load templates + emit compose_opened, hydrate body
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    // Hydrate the contentEditable from the persisted HTML draft.
    if (bodyRef.current && draft.body && bodyRef.current.innerHTML !== draft.body) {
      bodyRef.current.innerHTML = draft.body;
    }

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
  }, [user.id, user.role, draft.body]);

  // -------------------------------------------------------------------------
  // Draft persistence
  // -------------------------------------------------------------------------

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  // -------------------------------------------------------------------------
  // Calendar (year-window) loader — single fetch per session
  // -------------------------------------------------------------------------

  const loadCalendarYear = useCallback(async (): Promise<CalendarEventLite[]> => {
    if (calendarYearCacheRef.current) return calendarYearCacheRef.current.events;
    if (calendarYearInflightRef.current) return calendarYearInflightRef.current;
    const p = (async () => {
      try {
        const res = await fetchWithRefresh(
          "/api/calendar/range?view=year",
          { headers: jsonHeaders() },
        );
        if (!res.ok) return [];
        const data = await res.json();
        const events: CalendarEventLite[] = Array.isArray(data.events) ? data.events : [];
        calendarYearCacheRef.current = { events, loadedAtMs: Date.now() };
        return events;
      } catch {
        return [];
      } finally {
        calendarYearInflightRef.current = null;
      }
    })();
    calendarYearInflightRef.current = p;
    return p;
  }, []);

  // -------------------------------------------------------------------------
  // Per-recipient insight load (cached)
  // -------------------------------------------------------------------------

  const loadRecipientInsight = useCallback(
    async (recipient: string): Promise<RecipientInsight> => {
      const key = recipient.toLowerCase();

      // Already cached? Return cached entry. Set loading flag only when
      // we actually need to fetch.
      const existing = insightsCache[key];
      if (existing && !existing.loading) return existing;
      if (existing && existing.loading) return existing;

      setInsightsCache((c) => ({
        ...c,
        [key]: {
          loading: true,
          recentThreads: [],
          lastMeeting: null,
          summary: "",
          error: null,
        },
      }));

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
        /* tolerate */
      }

      try {
        const events = await loadCalendarYear();
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
      } catch {
        /* tolerate */
      }

      const computed: RecipientInsight = {
        loading: false,
        recentThreads,
        lastMeeting,
        summary,
        error: null,
      };

      setInsightsCache((c) => ({ ...c, [key]: computed }));
      return computed;
    },
    [insightsCache, loadCalendarYear],
  );

  // -------------------------------------------------------------------------
  // Multi-recipient orchestrator (debounced)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (insightsTimerRef.current) {
      clearTimeout(insightsTimerRef.current);
      insightsTimerRef.current = null;
    }
    if (draft.to.length === 0) return;

    insightsTimerRef.current = setTimeout(() => {
      void (async () => {
        const recipients = draft.to.slice();
        const recipientCount = recipients.length;
        const mode: "single" | "multi" | "aggregate" =
          recipientCount === 1
            ? "single"
            : recipientCount >= AGGREGATE_THRESHOLD
              ? "aggregate"
              : "multi";

        let perRecipientFetched = 0;

        if (mode === "aggregate") {
          // Skip per-recipient fetches entirely; calendar still loaded
          // once for aggregate "earliest last-meeting" calc.
          await loadCalendarYear();
        } else {
          // single + multi: fetch each recipient (cached so unchanged
          // recipients are no-ops).
          const results = await Promise.all(
            recipients.map((r) => {
              const key = r.toLowerCase();
              const cached = insightsCache[key];
              if (cached && !cached.loading) return Promise.resolve(cached);
              perRecipientFetched += 1;
              return loadRecipientInsight(r);
            }),
          );
          // Touch results so the linter knows we used them.
          void results;
        }

        emitInsight({
          actor: user.id,
          role: user.role,
          surface: "email",
          action: "insights_loaded",
          tier: "personal",
          payload: {
            recipient_count: recipientCount,
            mode,
            per_recipient_fetched: perRecipientFetched,
            // Backwards-compat scalars consumers (warehouse) already key off:
            recipient: recipients[0] ?? "",
          },
        });
      })();
    }, 50);

    return () => {
      if (insightsTimerRef.current) {
        clearTimeout(insightsTimerRef.current);
        insightsTimerRef.current = null;
      }
    };
    // We intentionally exclude insightsCache + loadRecipientInsight from
    // deps — re-running on cache mutations would loop forever. The
    // recipient list is the canonical trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.to.join("|"), user.id, user.role]);

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
  // Body editor
  // -------------------------------------------------------------------------

  function setBodyHtml(html: string) {
    if (bodyRef.current) {
      bodyRef.current.innerHTML = html;
    }
    setDraft((prev) => ({ ...prev, body: html }));
  }

  function applyFormat(format: "bold" | "italic" | "underline" | "ul" | "ol") {
    if (typeof document === "undefined") return;
    const cmd =
      format === "bold"
        ? "bold"
        : format === "italic"
          ? "italic"
          : format === "underline"
            ? "underline"
            : format === "ul"
              ? "insertUnorderedList"
              : "insertOrderedList";
    // Focus the editor first so execCommand operates on the right
    // selection; otherwise toolbar clicks blur it and the command
    // becomes a no-op.
    bodyRef.current?.focus();
    try {
      document.execCommand(cmd, false);
    } catch {
      /* execCommand is deprecated but supported in every modern browser */
    }
    if (bodyRef.current) {
      setDraft((prev) => ({ ...prev, body: bodyRef.current!.innerHTML }));
    }
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "format_applied",
      tier: "personal",
      payload: { format },
    });
  }

  // -------------------------------------------------------------------------
  // Template insertion
  // -------------------------------------------------------------------------

  function applyTemplate(t: EmailTemplate) {
    const variableLines = [
      ...t.requiredVariables.map((v) => `${v}: `),
      ...t.optionalVariables.map((v) => `${v} (optional): `),
    ];
    const plain = `${t.description}\n\n${variableLines.join("\n")}`.trim();
    const html = plainTextToHtml(plain);
    setDraft((prev) => ({ ...prev, subject: t.name, body: html }));
    if (bodyRef.current) bodyRef.current.innerHTML = html;
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
          draftSoFar: htmlToPlainText(draft.body),
        }),
      });
      if (!res.ok) {
        setError("Couldn't draft a reply. Try again.");
        return;
      }
      const data = (await res.json()) as { text?: string };
      const suggested = (data.text ?? "").trim();
      if (suggested) {
        // Escape any HTML in the model output and convert newlines to
        // <br>. Never trust raw model output as HTML.
        const html = plainTextToHtml(suggested);
        setBodyHtml(html);
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
    const text = htmlToPlainText(draft.body).trim();
    if (!text) return false;
    return true;
  }

  async function send() {
    if (!canSend()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);

    const bodyHtml = draft.body || plainTextToHtml(htmlToPlainText(draft.body));
    const bodyText = htmlToPlainText(bodyHtml);

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
      if (bodyRef.current) bodyRef.current.innerHTML = "";
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
    if (bodyRef.current) bodyRef.current.innerHTML = "";
    setShowCc(false);
    setShowBcc(false);
    setError(null);
    setSuccess(null);
  }

  // -------------------------------------------------------------------------
  // Recipient card expand/collapse (multi mode)
  // -------------------------------------------------------------------------

  function toggleRecipientCard(recipient: string) {
    const key = recipient.toLowerCase();
    const willExpand = !expandedRecipients.has(key);
    setExpandedRecipients((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(key);
      else next.delete(key);
      return next;
    });
    if (willExpand) {
      // Ensure the card has data even if it was loaded only as a stub.
      void loadRecipientInsight(recipient);
      emitInsight({
        actor: user.id,
        role: user.role,
        surface: "email",
        action: "recipient_card_expanded",
        tier: "personal",
        target: recipient,
        payload: {},
      });
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers — recipient panels
  // -------------------------------------------------------------------------

  const recipientCount = draft.to.length;
  const mode: "empty" | "single" | "multi" | "aggregate" =
    recipientCount === 0
      ? "empty"
      : recipientCount === 1
        ? "single"
        : recipientCount >= AGGREGATE_THRESHOLD
          ? "aggregate"
          : "multi";

  function getCachedInsight(email: string): RecipientInsight | undefined {
    return insightsCache[email.toLowerCase()];
  }

  function renderSinglePanel(recipient: string) {
    const ins = getCachedInsight(recipient);
    if (!ins || ins.loading) {
      return (
        <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
          Loading insights for {recipient}…
        </p>
      );
    }
    return (
      <>
        <div style={insightCell} data-testid="insight-recipient">
          <span style={cellLabel}>Recipient</span>
          <span style={cellValue}>{recipient}</span>
        </div>

        <div style={insightCell} data-testid="insight-recent-threads">
          <span style={cellLabel}>
            Recent threads ({ins.recentThreads.length})
          </span>
          {ins.recentThreads.length === 0 ? (
            <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
              No prior emails found.
            </span>
          ) : (
            <ul style={threadList}>
              {ins.recentThreads.map((t) => (
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
          {ins.lastMeeting ? (
            <>
              <span style={cellValue}>{ins.lastMeeting.subject}</span>
              <span style={{ ...cellValue, color: "var(--wp-text-dim)", fontSize: "0.75rem" }}>
                {formatRelative(ins.lastMeeting.start)}
              </span>
            </>
          ) : (
            <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
              No past meeting in the last year.
            </span>
          )}
        </div>

        {ins.summary && (
          <div style={insightCell} data-testid="insight-summary">
            <span style={cellLabel}>Last message preview</span>
            <span style={{ ...cellValue, color: "var(--wp-text-dim)", fontSize: "0.78rem" }}>
              {ins.summary}
            </span>
          </div>
        )}
      </>
    );
  }

  function renderMultiPanel(recipients: string[]) {
    return (
      <div data-testid="insight-multi" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
          {recipients.length} recipients · click a card to expand
        </span>
        {recipients.map((r) => {
          const key = r.toLowerCase();
          const ins = getCachedInsight(r);
          const expanded = expandedRecipients.has(key);
          const threadCount = ins?.recentThreads.length ?? 0;
          const lastMtg = ins?.lastMeeting?.start ?? null;
          return (
            <div
              key={r}
              data-testid={`recipient-card-${r}`}
              style={{
                ...insightCell,
                padding: "0.5rem 0.6rem",
                cursor: "pointer",
              }}
              onClick={() => toggleRecipientCard(r)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRecipientCard(r);
                }
              }}
            >
              <span style={cellValue}>{r}</span>
              <span style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)" }}>
                {ins?.loading
                  ? "loading…"
                  : `${threadCount} recent thread${threadCount === 1 ? "" : "s"} · last meeting: ${
                      lastMtg ? formatRelative(lastMtg) : "—"
                    }`}
              </span>
              {expanded && ins && !ins.loading && (
                <div
                  data-testid={`recipient-card-expanded-${r}`}
                  style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}
                >
                  {ins.recentThreads.length > 0 && (
                    <ul style={threadList}>
                      {ins.recentThreads.slice(0, 3).map((t) => (
                        <li key={t.id} style={threadItem}>
                          <span style={threadSubject}>{t.subject || "(no subject)"}</span>
                          <span style={threadMeta}>
                            {formatRelative(t.receivedDateTime)} · {t.from}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {ins.lastMeeting && (
                    <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>
                      Last meeting: {ins.lastMeeting.subject} ({formatRelative(ins.lastMeeting.start)})
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function renderAggregatePanel(recipients: string[]) {
    // Aggregate uses calendar year-window cache only (no per-recipient
    // email fetches). Compute earliest last-meeting + most-recent
    // thread across whatever cache rows already exist.
    const events = calendarYearCacheRef.current?.events ?? [];
    const recipLowers = new Set(recipients.map((r) => r.toLowerCase()));
    const matching = events
      .filter((ev) => {
        const emails = (ev.attendeeEmails ?? []).map((e) => e.toLowerCase());
        return emails.some((e) => recipLowers.has(e));
      })
      .filter((ev) => {
        const t = Date.parse(ev.start);
        return !Number.isNaN(t) && t <= Date.now();
      })
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

    const earliestLastMeeting = matching[matching.length - 1] ?? null;
    const mostRecentMeeting = matching[0] ?? null;

    return (
      <div data-testid="insight-aggregate" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={insightCell}>
          <span style={cellLabel}>Recipients</span>
          <span style={cellValue}>
            {recipients.length}+ recipients
          </span>
          <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
            Per-recipient context skipped to protect Graph quota.
          </span>
        </div>
        <div style={insightCell}>
          <span style={cellLabel}>Earliest last-meeting</span>
          <span style={cellValue}>
            {earliestLastMeeting
              ? `${earliestLastMeeting.subject} (${formatRelative(earliestLastMeeting.start)})`
              : "—"}
          </span>
        </div>
        <div style={insightCell}>
          <span style={cellLabel}>Most recent meeting</span>
          <span style={cellValue}>
            {mostRecentMeeting
              ? `${mostRecentMeeting.subject} (${formatRelative(mostRecentMeeting.start)})`
              : "—"}
          </span>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Build responsive page styles. On narrow screens we stack the 3
  // panes vertically and let the page scroll — the previous fixed
  // 3-column row clipped the insights panel below the fold and made
  // it invisible on mobile entirely.
  // On mobile the global assistant FAB (bottom-6 right-6, ~56px square)
  // sits directly on top of the Send button when the page is scrolled to
  // the bottom of the composer. Reserve ~6rem of scroll tail so Send
  // stays reachable above the FAB's footprint.
  const responsivePageWrap: React.CSSProperties = {
    ...pageWrap,
    flexDirection: isNarrow ? "column" : "row",
    overflow: isNarrow ? "auto" : "hidden",
    flexWrap: isNarrow ? "nowrap" : "wrap",
    paddingBottom: isMobile ? "6rem" : pageWrap.padding,
  };
  // Narrow-viewport pane order: composer first (primary action), then
  // recipient insights (context), then templates (secondary). Users who
  // land on /emails expect to compose — templates shouldn't push the
  // form below the fold.
  const responsiveComposerWrap: React.CSSProperties = {
    ...composerWrap,
    width: isNarrow ? "100%" : undefined,
    minWidth: isNarrow ? "0" : "320px",
    flex: isNarrow ? "1 0 auto" : "1 1 480px",
    order: isNarrow ? 1 : 0,
  };
  const responsiveInsightsWrap: React.CSSProperties = {
    ...insightsWrap,
    width: isNarrow ? "100%" : "320px",
    flexShrink: isNarrow ? 1 : 0,
    order: isNarrow ? 2 : 0,
  };
  const responsiveSidebarStyle: React.CSSProperties = {
    ...sidebarStyle,
    width: isMobile
      ? "100%"
      : templatesOpen
        ? "260px"
        : "44px",
    maxHeight: isMobile && templatesOpen ? "260px" : undefined,
    flexShrink: isMobile ? 0 : 0,
    order: isNarrow ? 3 : 0,
  };

  return (
    <div style={responsivePageWrap} data-testid="emails-page">
      {/* Templates sidebar */}
      <aside
        style={responsiveSidebarStyle}
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
        style={responsiveComposerWrap}
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

          <div style={{ ...fieldLabel, flex: 1, minHeight: 0 }}>
            <span style={fieldLabelText}>Body</span>

            {/* Formatting toolbar */}
            <div style={toolbarRow} role="toolbar" aria-label="Formatting toolbar">
              <button
                type="button"
                aria-label="Bold"
                data-testid="format-bold"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat("bold")}
                style={{ ...toolbarBtn, fontWeight: 700 }}
              >
                B
              </button>
              <button
                type="button"
                aria-label="Italic"
                data-testid="format-italic"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat("italic")}
                style={{ ...toolbarBtn, fontStyle: "italic" }}
              >
                I
              </button>
              <button
                type="button"
                aria-label="Underline"
                data-testid="format-underline"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat("underline")}
                style={{ ...toolbarBtn, textDecoration: "underline" }}
              >
                U
              </button>
              <span style={toolbarDivider} />
              <button
                type="button"
                aria-label="Bulleted list"
                data-testid="format-ul"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat("ul")}
                style={toolbarBtn}
              >
                •
              </button>
              <button
                type="button"
                aria-label="Numbered list"
                data-testid="format-ol"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat("ol")}
                style={toolbarBtn}
              >
                1.
              </button>
            </div>

            <div
              ref={bodyRef}
              contentEditable
              role="textbox"
              aria-multiline="true"
              aria-label="Email body"
              data-testid="compose-body"
              onInput={() => {
                setDraft((prev) => ({ ...prev, body: bodyRef.current?.innerHTML ?? "" }));
              }}
              suppressContentEditableWarning
              style={bodyEditor}
            />
          </div>

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
      <aside style={responsiveInsightsWrap} aria-label="Recipient insights" data-testid="insights-panel">
        <header style={insightsHeader}>
          <span style={{ color: "var(--wp-gold)", fontWeight: 600, fontSize: "0.85rem" }}>
            Recipient context
          </span>
        </header>
        <div style={insightsBody}>
          {mode === "empty" && (
            <p style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Add a To: recipient to see recent threads, last meeting, and an
              AI-summary of past correspondence.
            </p>
          )}
          {mode === "single" && renderSinglePanel(draft.to[0]!)}
          {mode === "multi" && renderMultiPanel(draft.to)}
          {mode === "aggregate" && renderAggregatePanel(draft.to)}
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

const toolbarRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: "0.3rem 0.4rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderTopLeftRadius: "5px",
  borderTopRightRadius: "5px",
  borderBottom: "none",
};

const toolbarBtn: React.CSSProperties = {
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "4px",
  color: "var(--wp-text)",
  cursor: "pointer",
  padding: "0.18rem 0.5rem",
  fontSize: "0.82rem",
  lineHeight: 1.1,
  minWidth: "26px",
  textAlign: "center",
};

const toolbarDivider: React.CSSProperties = {
  display: "inline-block",
  width: "1px",
  height: "16px",
  background: "var(--wp-dark-border)",
  margin: "0 0.25rem",
};

const bodyEditor: React.CSSProperties = {
  padding: "0.65rem 0.75rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  borderBottomLeftRadius: "5px",
  borderBottomRightRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.88rem",
  minHeight: "180px",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
  flex: 1,
  overflowY: "auto",
  whiteSpace: "pre-wrap",
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
  flexWrap: "wrap",
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
    whiteSpace: "nowrap",
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
