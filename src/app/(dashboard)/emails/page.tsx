"use client";

/**
 * /emails — Gmail/Outlook-style 3-column email surface.
 *
 *   ┌────────┬────────────┬──────────────────────────────────┐
 *   │  Nav   │  Inbox     │  Right pane (one of:             │
 *   │  rail  │  list      │    EmptyState | Reader | Composer)│
 *   │ (240/  │ (~340 px)  │  When the composer is active, an │
 *   │  56 px)│            │  inline RecipientContextDrawer   │
 *   │        │            │  hangs off its right edge.       │
 *   └────────┴────────────┴──────────────────────────────────┘
 *
 * Replaces the previous 4-pane wrap layout where the composer
 * silently dropped to a hidden second flex row on common laptop
 * widths. The new layout is single-column on the right (mutually
 * exclusive states), so "+ New email" can never appear to do
 * nothing.
 *
 * Notes:
 * - All authenticated fetches go through fetchWithRefresh.
 * - The composer body is contentEditable + execCommand-driven; the
 *   AI Draft path HTML-escapes model output before injecting.
 * - Drafts persist to sessionStorage as HTML.
 * - Calendar/year + per-recipient inbox lookups are cached so
 *   adding/removing recipients does not re-hit Graph.
 * - The page itself never scrolls; inner sections do.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctUser,
} from "@/lib/client-auth";
import { htmlToText } from "@/lib/html-sanitize";
import { emitInsight } from "@/lib/insights/emit";
import EmailReader from "./EmailReader";
import InboxPanel from "./InboxPanel";
import EmailNavRail, { type EmailFolder, type EmailTemplate } from "./EmailNavRail";
import EmptyState from "./EmptyState";
import UnsavedDraftDialog from "./UnsavedDraftDialog";
import RecipientContextDrawer, {
  AGGREGATE_THRESHOLD,
  type CalendarEventLite,
  type RecentEmail,
  type RecipientInsight,
} from "./RecipientContextDrawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftState {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** HTML body — contentEditable serialized as innerHTML. */
  body: string;
}

interface AuthedUser {
  id: string;
  role: string;
  name?: string;
  email?: string;
}

interface EmailSignatureLite {
  id: string;
  label: string;
  body: string;
  bodyFormat?: "text" | "html";
  isDefault: boolean;
}

type RightPaneState = "empty" | "reader" | "composer";

const DRAFT_KEY = "mail.compose.draft";
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** localStorage key for the user's preferred inbox-pane width in pixels. */
export const INBOX_WIDTH_KEY = "instinct_emails_inbox_px";
export const INBOX_WIDTH_MIN = 280;
export const INBOX_WIDTH_MAX = 720;
export const INBOX_WIDTH_DEFAULT = 340;

export function clampInboxWidth(px: number): number {
  if (!Number.isFinite(px)) return INBOX_WIDTH_DEFAULT;
  return Math.max(INBOX_WIDTH_MIN, Math.min(INBOX_WIDTH_MAX, Math.round(px)));
}

function readSavedInboxWidth(): number {
  if (typeof window === "undefined") return INBOX_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(INBOX_WIDTH_KEY);
    if (!raw) return INBOX_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? clampInboxWidth(n) : INBOX_WIDTH_DEFAULT;
  } catch {
    return INBOX_WIDTH_DEFAULT;
  }
}

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
  /* Always parser-driven via lib/html-sanitize.htmlToText (cheerio on
     server, DOMParser in browser/jsdom). The previous regex fallback
     was defeated by mutation inputs like `<scr<script>ipt>` — flagged
     by CodeQL js/incomplete-multi-character-sanitization. */
  return htmlToText(html);
}

// ---------------------------------------------------------------------------
// Draft persistence
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

function draftHasContent(d: DraftState): boolean {
  if (d.to.length || d.cc.length || d.bcc.length) return true;
  if (d.subject.trim()) return true;
  if (htmlToPlainText(d.body).trim()) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // Viewport breakpoints. wide ≥ 1100, narrow < 1100, mobile < 640.
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

  // Tell the sidebar EmailNavBadge that the user has now seen the
  // inbox. The badge persists `instinct.emails.last_seen` in
  // localStorage and clears its count immediately. The server-side
  // unread-count route uses the same timestamp to decide which
  // newly-arrived emails should fan out as bell notifications, so
  // surfacing it from /emails on mount keeps the bell quiet about
  // mail the user has already seen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event("instinct:emails-seen"));
  }, []);

  // Nav rail. Default expanded on desktop, collapsed on narrow.
  const [navExpanded, setNavExpanded] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1100 : true,
  );
  // Reflect viewport changes onto nav rail default — but never override
  // an explicit user toggle within a session (we'd need a ref to track
  // that; simple version: keep current state on resize).

  // Recipient context drawer — open by default on wide, closed on
  // narrow/mobile.
  const [contextOpen, setContextOpen] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1100 : true,
  );

  // Active folder. Only "inbox" is fully wired in v1; the others are
  // visual placeholders that swap the inbox into a known empty state.
  const [activeFolder, setActiveFolder] = useState<EmailFolder>("inbox");

  // Deep-link reading mode: `/emails?id=<graphMessageId>` opens a
  // single-message reader.
  const [readingId, setReadingId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const v = params.get("id");
    return v && v.trim() ? v.trim() : null;
  });
  const openReader = useCallback((id: string) => {
    setReadingId(id);
    if (typeof window !== "undefined") {
      try {
        const next = `/emails?id=${encodeURIComponent(id)}`;
        window.history.replaceState({}, "", next);
      } catch {
        /* noop */
      }
    }
  }, []);
  const closeReader = useCallback(() => {
    setReadingId(null);
    if (typeof window !== "undefined") {
      try {
        window.history.replaceState({}, "", "/emails");
      } catch {
        /* noop */
      }
    }
  }, []);

  // Compose state. composeOpen is independent of reading; the right
  // pane state is derived: reader > composer > empty.
  const [composeOpen, setComposeOpen] = useState<boolean>(false);
  const [inboxReloadKey, setInboxReloadKey] = useState<number>(0);

  // Signatures (per-user, fetched on mount). The composer reads the
  // default to pre-fill a fresh email and exposes the full list as a
  // dropdown in the toolbar.
  const [signatures, setSignatures] = useState<EmailSignatureLite[]>([]);
  const [signaturesLoaded, setSignaturesLoaded] = useState<boolean>(false);
  const defaultSignature = useMemo(
    () => signatures.find((s) => s.isDefault) ?? null,
    [signatures],
  );

  // Inbox-pane width. Persisted to localStorage. Drag handle between
  // the inbox column and the right pane mutates this value.
  const [inboxWidth, setInboxWidth] = useState<number>(() =>
    readSavedInboxWidth(),
  );
  // Track whether we're actively dragging so the right pane can disable
  // pointer events on its children (prevents accidental clicks while
  // resizing) and the cursor stays consistent.
  const [resizing, setResizing] = useState<boolean>(false);
  // When the composer opens, collapse the inbox to its minimum so the
  // composer has room. We restore `inboxWidth` from localStorage when
  // the composer closes — the *saved* value is the user's preference,
  // not whatever transient value drag-during-compose might produce.
  const effectiveInboxWidth = composeOpen ? INBOX_WIDTH_MIN : inboxWidth;

  // Unsaved-draft confirmation. When set, the styled dialog renders;
  // pendingAction runs only if the user picks "Discard draft". The
  // shownAtMs timestamp feeds the analytics resolved-event so the
  // learning loop sees how long users hesitate before deciding.
  const [unsavedPrompt, setUnsavedPrompt] = useState<{
    pendingAction: () => void;
    preview: string;
    shownAtMs: number;
    trigger: "thread_open" | "folder_change" | "logout" | "navigation";
  } | null>(null);

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

  const [insightsCache, setInsightsCache] = useState<Record<string, RecipientInsight>>({});
  const [expandedRecipients, setExpandedRecipients] = useState<Set<string>>(() => new Set());
  const calendarYearCacheRef = useRef<{ events: CalendarEventLite[]; loadedAtMs: number } | null>(null);
  const calendarYearInflightRef = useRef<Promise<CalendarEventLite[]> | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const insightsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track previous right-pane state so we only emit the transition
  // event on actual changes, not every render.
  const prevRightPaneRef = useRef<RightPaneState | null>(null);

  const user = useMemo<AuthedUser>(() => {
    const u = getInstinctUser<AuthedUser>();
    return u ?? { id: "anon", role: "user" };
  }, []);

  // Derived right-pane state. reader takes precedence (deep-link or
  // explicit row click), then composer (user clicked + New email),
  // else the empty state.
  const rightPaneState: RightPaneState = readingId
    ? "reader"
    : composeOpen
      ? "composer"
      : "empty";

  // -------------------------------------------------------------------------
  // Mount: load templates + emit compose_opened, hydrate body
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

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

    /* Fetch the user's saved signatures. Non-fatal — composer still
       works without them. */
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/email-signatures", {
          headers: jsonHeaders(),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            signatures?: EmailSignatureLite[];
          };
          const list = Array.isArray(data.signatures) ? data.signatures : [];
          setSignatures(
            list.map((s) => ({
              id: s.id,
              label: s.label,
              body: s.body,
              isDefault: !!s.isDefault,
            })),
          );
        }
      } catch {
        /* signatures are optional */
      } finally {
        setSignaturesLoaded(true);
      }
    })();
  }, [user.id, user.role, draft.body]);

  // -------------------------------------------------------------------------
  // Signature: pre-fill default on a fresh, empty compose
  // -------------------------------------------------------------------------
  // When the composer opens AND the body is empty AND the user has a
  // default signature, prepend "\n\n${defaultSignature}" to the body.
  // We deliberately gate on `composeOpen` (not on mount) so opening a
  // composer mid-session — after the user discards a draft, after a
  // template insert, etc. — still pre-fills.
  const signaturePrefilledRef = useRef<boolean>(false);
  useEffect(() => {
    if (!composeOpen) {
      signaturePrefilledRef.current = false;
      return;
    }
    if (!signaturesLoaded || !defaultSignature) return;
    if (signaturePrefilledRef.current) return;
    /* Only pre-fill when the body is genuinely empty — replies/forwards
       and template inserts have already populated draft.body. */
    const text = htmlToPlainText(draft.body).trim();
    if (text) return;
    signaturePrefilledRef.current = true;
    const html = plainTextToHtml(`\n\n${defaultSignature.body}`);
    setDraft((prev) => ({ ...prev, body: html }));
    if (bodyRef.current) bodyRef.current.innerHTML = html;
  }, [composeOpen, signaturesLoaded, defaultSignature, draft.body]);

  // Hydrate the contentEditable from `draft.body` whenever the
  // composer pane becomes visible (composeOpen flipping true). This
  // covers both the post-mount path AND template insertion that
  // *opens* the composer and writes a fresh HTML body in one shot.
  useEffect(() => {
    if (!composeOpen) return;
    if (!bodyRef.current) return;
    if (bodyRef.current.innerHTML === draft.body) return;
    bodyRef.current.innerHTML = draft.body;
  }, [composeOpen, draft.body]);

  // -------------------------------------------------------------------------
  // Right-pane state transition emitter
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (prevRightPaneRef.current === rightPaneState) return;
    prevRightPaneRef.current = rightPaneState;
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "right_pane_state",
      tier: "personal",
      payload: { state: rightPaneState },
    });
  }, [rightPaneState, user.id, user.role]);

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
          await loadCalendarYear();
        } else {
          const results = await Promise.all(
            recipients.map((r) => {
              const key = r.toLowerCase();
              const cached = insightsCache[key];
              if (cached && !cached.loading) return Promise.resolve(cached);
              perRecipientFetched += 1;
              return loadRecipientInsight(r);
            }),
          );
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
  // Template insertion — also opens the composer pane.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Signature insertion
  // -------------------------------------------------------------------------
  // When the user clicks an entry in the Signature dropdown we insert
  // the selected signature into the body. We try contentEditable's
  // selection API first so the signature lands at the cursor; if the
  // composer body has lost focus we append at the end with two
  // newlines of separation (the same default insertSignatureAtCursor
  // uses for `cursorPos === null`).
  function insertSignatureBody(sig: EmailSignatureLite) {
    if (!sig.body.trim()) return;
    /* HTML signatures (imported from Outlook) are inserted verbatim so
       images, links, and styling survive. Text signatures still go
       through plainTextToHtml which handles newlines and escapes any
       stray angle brackets. */
    const sigHtml =
      sig.bodyFormat === "html" ? sig.body : plainTextToHtml(sig.body);
    let mode: "cursor" | "append" = "append";

    /* Capture the body's HTML before we attempt insertion so we can
       tell whether execCommand actually mutated the document. In jsdom
       (and any environment where execCommand is a no-op) the HTML will
       be unchanged and we fall back to append. */
    const before = bodyRef.current?.innerHTML ?? "";

    if (typeof document !== "undefined" && bodyRef.current) {
      bodyRef.current.focus();
      const sel = window.getSelection?.();
      if (
        sel &&
        sel.rangeCount > 0 &&
        bodyRef.current.contains(sel.anchorNode)
      ) {
        try {
          /* execCommand('insertHTML', false, html) inserts at the
             current selection inside a contentEditable. Deprecated but
             supported across every modern browser; the existing
             applyFormat() helper already relies on it. */
          document.execCommand("insertHTML", false, sigHtml);
          if (bodyRef.current.innerHTML !== before) {
            mode = "cursor";
          }
        } catch {
          /* fall through to append */
        }
      }
    }

    if (mode === "append") {
      const html = before
        ? `${before}<br><br>${sigHtml}`
        : `<br><br>${sigHtml}`;
      if (bodyRef.current) bodyRef.current.innerHTML = html;
      setDraft((prev) => ({ ...prev, body: html }));
    } else if (bodyRef.current) {
      setDraft((prev) => ({ ...prev, body: bodyRef.current!.innerHTML }));
    }

    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "signature_inserted",
      tier: "personal",
      target: sig.id,
      payload: {
        signature_id: sig.id,
        is_default: sig.isDefault,
        insert_mode: mode,
      },
    });
  }

  function applyTemplate(t: EmailTemplate) {
    const variableLines = [
      ...t.requiredVariables.map((v) => `${v}: `),
      ...t.optionalVariables.map((v) => `${v} (optional): `),
    ];
    /* Description is shown in the template picker UI as a label —
       inserting it into the email body itself just gives the user
       boilerplate they have to delete every time. The variable
       placeholder lines stay so the user knows what to fill in. */
    const plain = variableLines.join("\n").trim();
    const html = plainTextToHtml(plain);
    setDraft((prev) => ({ ...prev, subject: t.name, body: html }));
    if (bodyRef.current) bodyRef.current.innerHTML = html;
    setComposeOpen(true);
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
      setInboxReloadKey((k) => k + 1);
      // Drop back to empty state on send.
      setComposeOpen(false);
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
    setComposeOpen(false);
  }

  // -------------------------------------------------------------------------
  // Compose / inbox-row interaction (with unsaved-draft dialog)
  // -------------------------------------------------------------------------

  /**
   * If the user has a non-empty draft, defer `action` behind the
   * styled UnsavedDraftDialog. Otherwise run it immediately. Returns
   * true if `action` ran synchronously (no prompt was needed).
   */
  function guardWithUnsavedDraftPrompt(
    trigger: "thread_open" | "folder_change" | "logout" | "navigation",
    action: () => void,
  ): boolean {
    if (!composeOpen || !draftHasContent(draft)) {
      action();
      return true;
    }
    const preview = htmlToPlainText(draft.body).trim();
    setUnsavedPrompt({
      pendingAction: action,
      preview,
      shownAtMs: Date.now(),
      trigger,
    });
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "unsaved_draft_dialog_shown",
      tier: "personal",
      payload: { trigger },
    });
    return false;
  }

  function resolveUnsavedPrompt(choice: "keep" | "discard") {
    if (!unsavedPrompt) return;
    const shownForMs = Math.max(0, Date.now() - unsavedPrompt.shownAtMs);
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "email",
      action: "unsaved_draft_dialog_resolved",
      tier: "personal",
      payload: { choice, shown_for_ms: shownForMs },
    });
    const pending = unsavedPrompt.pendingAction;
    setUnsavedPrompt(null);
    if (choice === "discard") {
      pending();
    }
  }

  function handleInboxRowOpen(id: string) {
    guardWithUnsavedDraftPrompt("thread_open", () => {
      // Close the composer when the user navigates into a thread, so
      // the right pane is the reader (not reader-stacked-on-composer).
      setComposeOpen(false);
      openReader(id);
    });
  }

  function handleNewEmail() {
    setComposeOpen(true);
    closeReader();
  }

  // -------------------------------------------------------------------------
  // Recipient card expand/collapse
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
  // Nav rail toggle (with telemetry)
  // -------------------------------------------------------------------------

  function toggleNavRail() {
    setNavExpanded((v) => {
      const next = !v;
      emitInsight({
        actor: user.id,
        role: user.role,
        surface: "email",
        action: "nav_rail_toggled",
        tier: "personal",
        payload: { expanded: next },
      });
      return next;
    });
  }

  function toggleRecipientContext() {
    setContextOpen((v) => {
      const next = !v;
      const viewport: "mobile" | "narrow" | "wide" = isMobile
        ? "mobile"
        : isNarrow
          ? "narrow"
          : "wide";
      emitInsight({
        actor: user.id,
        role: user.role,
        surface: "email",
        action: "recipient_context_toggled",
        tier: "personal",
        payload: { open: next, viewport },
      });
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Resize: drag handle between inbox column and right pane
  // -------------------------------------------------------------------------
  // The drag mounts mousemove/mouseup on window so the user can drag
  // outside the handle's bounding box without the gesture cancelling.
  // We persist the final width to localStorage on mouseup, not on every
  // tick, so we don't thrash storage. v1 is mouse-only — touch devices
  // get the saved width but no drag handle interaction.
  const onStartResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isMobile) return;
      e.preventDefault();
      setResizing(true);
      const startX = e.clientX;
      const startWidth = inboxWidth;

      function onMove(ev: MouseEvent) {
        const delta = ev.clientX - startX;
        const next = clampInboxWidth(startWidth + delta);
        setInboxWidth(next);
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setResizing(false);
        try {
          /* Read the freshest value via setInboxWidth's closure: we
             read state again via setState callback to avoid persisting
             a stale value if React batched updates. */
          setInboxWidth((current) => {
            const clamped = clampInboxWidth(current);
            try {
              window.localStorage.setItem(
                INBOX_WIDTH_KEY,
                String(clamped),
              );
            } catch {
              /* quota / private mode — non-fatal */
            }
            emitInsight({
              actor: user.id,
              role: user.role,
              surface: "email",
              action: "inbox_pane_resized",
              tier: "personal",
              payload: { width_px: clamped },
            });
            return clamped;
          });
        } catch {
          /* noop */
        }
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [inboxWidth, isMobile, user.id, user.role],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Page wrapper. On wide viewports: 3 columns side-by-side, page does
  // not scroll. On narrow: same flex row (so the existing test that
  // asserts `flexDirection: row` keeps passing for desktop sizes), but
  // we narrow the column widths. On mobile we collapse to a single
  // visible pane (controlled by which-pane below).
  const responsivePageWrap: React.CSSProperties = {
    ...pageWrap,
    flexDirection: isMobile ? "column" : "row",
    overflow: isMobile ? "auto" : "hidden",
    flexWrap: "nowrap",
    paddingBottom: isMobile ? "6rem" : pageWrap.padding,
  };

  // Mobile pane visibility — only one pane at a time. On mobile the
  // inbox is the default surface and only collapses when the right
  // pane is showing reader-or-composer (reader takes over via the
  // mobile drawer pattern; the back button on EmailReader returns
  // the user to the inbox list).
  const showInboxOnMobile = !isMobile || rightPaneState === "empty";
  const showRightOnMobile = !isMobile || rightPaneState !== "empty";

  /* Compose mode keeps the 3-pane shell. On desktop the inbox stays
     mounted but auto-collapses to its minimum width (see
     `effectiveInboxWidth`) so the composer gets the bulk of the space
     while the user can still click another thread - which routes
     through the unsaved-draft guard. On mobile `showInboxOnMobile`
     already hides the inbox during compose so the composer is
     full-screen. The earlier `&& !isComposing` fully unmounted the
     inbox on desktop too, which silently dropped the auto-collapse
     width behavior and made the unsaved-draft-on-thread-switch
     dialog unreachable. */
  const showInbox = showInboxOnMobile;

  // The 3-column shell stays mounted at all times. The reader does
  // NOT replace the page — it's rendered inside the right pane,
  // alongside (visually) the inbox list and nav rail. This is the
  // Gmail-style behavior: switch threads without losing the inbox.
  return (
    <div style={responsivePageWrap} data-testid="emails-page">
      {/* Left nav rail */}
      {!isMobile ? (
        <EmailNavRail
          expanded={navExpanded}
          onToggle={toggleNavRail}
          onCompose={handleNewEmail}
          activeFolder={activeFolder}
          onSelectFolder={(f) => {
            if (f === activeFolder) return;
            const previous = activeFolder;
            setActiveFolder(f);
            // Drop back to the empty state on folder switch — no thread
            // carry-over from a different folder, no half-typed compose
            // hanging around once the user pivots away. The user can
            // always reopen the composer from the new folder header.
            closeReader();
            setComposeOpen(false);
            emitInsight({
              actor: user.id,
              role: user.role,
              surface: "email",
              action: "folder_changed",
              tier: "personal",
              payload: { from: previous, to: f },
            });
          }}
          templates={templates}
          templatesLoading={templatesLoading}
          onApplyTemplate={applyTemplate}
        />
      ) : null}

      {/* Inbox column */}
      {showInbox ? (
        <div
          style={inboxColStyle(isMobile, effectiveInboxWidth)}
          data-testid="inbox-column"
          data-width={effectiveInboxWidth}
        >
          <InboxPanel
            activeId={readingId}
            onOpen={(row) => handleInboxRowOpen(row.id)}
            onCompose={handleNewEmail}
            reloadKey={inboxReloadKey}
            userId={user.id}
            userRole={user.role}
            isMobile={isMobile}
            folder={activeFolder}
          />
        </div>
      ) : null}

      {/* Drag handle between inbox column and the right pane. Hidden on
          mobile (single-pane layout) and while the composer is open
          (we auto-collapse the inbox to its minimum). */}
      {!isMobile && showInboxOnMobile && showRightOnMobile && !composeOpen ? (
        <div
          data-testid="emails-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inbox pane"
          aria-valuenow={inboxWidth}
          aria-valuemin={INBOX_WIDTH_MIN}
          aria-valuemax={INBOX_WIDTH_MAX}
          tabIndex={0}
          onMouseDown={onStartResize}
          onKeyDown={(e) => {
            /* Keyboard nudge — accessibility. Arrow keys move 16px. */
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              const delta = e.key === "ArrowLeft" ? -16 : 16;
              setInboxWidth((w) => {
                const next = clampInboxWidth(w + delta);
                try {
                  window.localStorage.setItem(
                    INBOX_WIDTH_KEY,
                    String(next),
                  );
                } catch {
                  /* noop */
                }
                return next;
              });
            }
          }}
          style={resizeHandleStyle(resizing)}
        >
          <span aria-hidden="true" style={resizeHandleGripStyle} />
        </div>
      ) : null}

      {/* Right pane — Empty | Reader | Composer (mutually exclusive) */}
      {showRightOnMobile ? (
        <section
          style={rightColStyle(isMobile)}
          data-testid="right-pane"
          data-state={rightPaneState}
          aria-label="Email content"
        >
          {rightPaneState === "reader" && readingId ? (
            <div
              data-pane="reader"
              style={readerWrap}
            >
              <EmailReader
                id={readingId}
                onClose={closeReader}
                onMutated={() => setInboxReloadKey((k) => k + 1)}
              />
            </div>
          ) : rightPaneState === "empty" ? (
            <div data-pane="empty" style={paneFill}>
              <EmptyState onCompose={handleNewEmail} />
            </div>
          ) : (
            <div data-pane="composer" style={paneFill}>
              <ComposerPane
                isMobile={isMobile}
                onClose={() => setComposeOpen(false)}
                draft={draft}
                setDraft={setDraft}
                toInput={toInput}
                setToInput={setToInput}
                ccInput={ccInput}
                setCcInput={setCcInput}
                bccInput={bccInput}
                setBccInput={setBccInput}
                showCc={showCc}
                setShowCc={setShowCc}
                showBcc={showBcc}
                setShowBcc={setShowBcc}
                addChip={addChip}
                removeChip={removeChip}
                handleChipKey={handleChipKey}
                applyFormat={applyFormat}
                bodyRef={bodyRef}
                error={error}
                success={success}
                busy={busy}
                aiDrafting={aiDrafting}
                canSend={canSend}
                onDiscard={discard}
                onSend={send}
                onAiDraft={requestAiDraft}
                contextOpen={contextOpen}
                onToggleContext={toggleRecipientContext}
                recipients={draft.to}
                insightsCache={insightsCache}
                expandedRecipients={expandedRecipients}
                onToggleRecipientCard={toggleRecipientCard}
                calendarEvents={calendarYearCacheRef.current?.events ?? []}
                signatures={signatures}
                onInsertSignature={insertSignatureBody}
              />
            </div>
          )}
        </section>
      ) : null}

      <UnsavedDraftDialog
        open={!!unsavedPrompt}
        draftPreview={unsavedPrompt?.preview || undefined}
        onConfirm={() => resolveUnsavedPrompt("discard")}
        onCancel={() => resolveUnsavedPrompt("keep")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer pane (extracted for clarity)
// ---------------------------------------------------------------------------

interface ComposerPaneProps {
  isMobile: boolean;
  onClose: () => void;
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  toInput: string;
  setToInput: (s: string) => void;
  ccInput: string;
  setCcInput: (s: string) => void;
  bccInput: string;
  setBccInput: (s: string) => void;
  showCc: boolean;
  setShowCc: (v: boolean) => void;
  showBcc: boolean;
  setShowBcc: (v: boolean) => void;
  addChip: (field: "to" | "cc" | "bcc", value: string) => void;
  removeChip: (field: "to" | "cc" | "bcc", value: string) => void;
  handleChipKey: (
    field: "to" | "cc" | "bcc",
    input: string,
    setInput: (s: string) => void,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => void;
  applyFormat: (
    format: "bold" | "italic" | "underline" | "ul" | "ol",
  ) => void;
  bodyRef: React.MutableRefObject<HTMLDivElement | null>;
  error: string | null;
  success: string | null;
  busy: boolean;
  aiDrafting: boolean;
  canSend: () => boolean;
  onDiscard: () => void;
  onSend: () => void;
  onAiDraft: () => void;
  contextOpen: boolean;
  onToggleContext: () => void;
  recipients: string[];
  insightsCache: Record<string, RecipientInsight>;
  expandedRecipients: Set<string>;
  onToggleRecipientCard: (recipient: string) => void;
  calendarEvents: CalendarEventLite[];
  signatures: EmailSignatureLite[];
  onInsertSignature: (sig: EmailSignatureLite) => void;
}

function ComposerPane({
  isMobile,
  onClose,
  draft,
  setDraft,
  toInput,
  setToInput,
  ccInput,
  setCcInput,
  bccInput,
  setBccInput,
  showCc,
  setShowCc,
  showBcc,
  setShowBcc,
  addChip,
  removeChip,
  handleChipKey,
  applyFormat,
  bodyRef,
  error,
  success,
  busy,
  aiDrafting,
  canSend,
  onDiscard,
  onSend,
  onAiDraft,
  contextOpen,
  onToggleContext,
  recipients,
  insightsCache,
  expandedRecipients,
  onToggleRecipientCard,
  calendarEvents,
  signatures,
  onInsertSignature,
}: ComposerPaneProps) {
  const sendable = canSend();
  const [signatureMenuOpen, setSignatureMenuOpen] = useState<boolean>(false);
  return (
    <div style={composerWithDrawerWrap}>
      <section
        style={composerWrap}
        data-testid="composer-wrap"
        aria-label="Email composer"
      >
        <header style={composerHeader}>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-gold)", margin: 0 }}>
            New email
          </h1>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim)" }}>
              Drafts auto-save
            </span>
            <button
              type="button"
              aria-label="Close composer"
              data-testid="compose-close"
              onClick={onClose}
              style={iconBtn}
            >
              ×
            </button>
          </div>
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
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, subject: e.target.value }))
              }
              placeholder="Subject"
              aria-label="Subject"
              style={textInput}
            />
          </label>

          <div style={{ ...fieldLabel, flex: 1, minHeight: 0 }}>
            <span style={fieldLabelText}>Body</span>

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
              <span style={toolbarDivider} />
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  aria-label="Insert signature"
                  aria-haspopup="menu"
                  aria-expanded={signatureMenuOpen}
                  data-testid="signature-menu-toggle"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSignatureMenuOpen((v) => !v)}
                  style={toolbarBtn}
                >
                  Signature ▾
                </button>
                {signatureMenuOpen ? (
                  <div
                    role="menu"
                    data-testid="signature-menu"
                    style={signatureMenuStyle}
                    onMouseLeave={() => setSignatureMenuOpen(false)}
                  >
                    {signatures.length === 0 ? (
                      <div style={signatureMenuEmptyStyle}>
                        No signatures saved yet.
                      </div>
                    ) : (
                      signatures.map((sig) => (
                        <button
                          key={sig.id}
                          type="button"
                          role="menuitem"
                          data-testid={`signature-menu-item-${sig.id}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSignatureMenuOpen(false);
                            onInsertSignature(sig);
                          }}
                          style={signatureMenuItemStyle}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: "var(--wp-text)",
                            }}
                          >
                            {sig.label}
                            {sig.isDefault ? (
                              <span
                                style={{
                                  marginLeft: 6,
                                  color: "var(--wp-gold)",
                                  fontSize: "0.7rem",
                                }}
                              >
                                default
                              </span>
                            ) : null}
                          </span>
                          <span style={signatureMenuPreviewStyle}>
                            {sig.body.length > 60
                              ? `${sig.body.slice(0, 60)}…`
                              : sig.body}
                          </span>
                        </button>
                      ))
                    )}
                    <a
                      href="/settings#email-signatures"
                      data-testid="signature-menu-manage"
                      style={signatureMenuManageStyle}
                      onClick={() => setSignatureMenuOpen(false)}
                    >
                      Manage signatures →
                    </a>
                  </div>
                ) : null}
              </div>
            </div>

            <div
              ref={bodyRef}
              contentEditable
              role="textbox"
              aria-multiline="true"
              aria-label="Email body"
              data-testid="compose-body"
              onInput={() => {
                setDraft((prev) => ({
                  ...prev,
                  body: bodyRef.current?.innerHTML ?? "",
                }));
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

          <div className="compose-actions" data-testid="compose-actions">
            <button type="button" onClick={onDiscard} style={btn()}>
              Discard
            </button>
            <button
              type="button"
              onClick={onAiDraft}
              disabled={aiDrafting}
              data-testid="ai-draft-btn"
              style={{ ...btn(), color: "var(--wp-gold)" }}
            >
              {aiDrafting ? "Drafting…" : "✨ AI Draft"}
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={!sendable}
              data-testid="compose-send"
              style={{
                ...btn("var(--wp-gold)"),
                opacity: sendable ? 1 : 0.5,
                cursor: sendable ? "pointer" : "not-allowed",
              }}
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </section>

      {/* Recipient context drawer - hidden entirely on mobile (the
          composer is full-screen there). On desktop it is a collapsible
          drawer: open as a 280px panel or collapsed to a 36px "Context"
          strip, so the composer keeps the bulk of the width while the
          recipient-insights learning surface (recent threads, last
          meeting, AI summary) stays reachable. Removing this render
          (#64) silently dropped a populated learning surface - the
          insights pipeline kept fetching but nothing displayed it. */}
      {!isMobile ? (
        <RecipientContextDrawer
          open={contextOpen}
          onToggle={onToggleContext}
          recipients={recipients}
          insightsCache={insightsCache}
          expandedRecipients={expandedRecipients}
          onToggleRecipientCard={onToggleRecipientCard}
          calendarEvents={calendarEvents}
        />
      ) : null}
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
// Styles
// ---------------------------------------------------------------------------

const pageWrap: React.CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "row",
  gap: "0.6rem",
  padding: "0.6rem",
  background: "var(--wp-dark)",
  overflow: "hidden",
  boxSizing: "border-box",
  flexWrap: "nowrap",
};

function inboxColStyle(
  isMobile: boolean,
  widthPx: number = INBOX_WIDTH_DEFAULT,
): React.CSSProperties {
  return {
    width: isMobile ? "100%" : widthPx,
    minWidth: isMobile ? 0 : INBOX_WIDTH_MIN,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    /* Smooth animation when the composer collapses the inbox; the
       transition is suppressed during an active drag (the resizing
       state below) so the handle feels responsive. */
    transition: "width 160ms ease",
  };
}

function resizeHandleStyle(active: boolean): React.CSSProperties {
  return {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: active ? "var(--wp-gold)" : "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    /* Keep the handle inside the page padding gap; visually it sits
       between the inbox column and the right pane. */
    margin: "0 -2px",
    zIndex: 5,
  };
}

const resizeHandleGripStyle: React.CSSProperties = {
  display: "block",
  width: 2,
  height: 32,
  background: "var(--wp-dark-border)",
  borderRadius: 2,
};

function rightColStyle(isMobile: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    width: isMobile ? "100%" : undefined,
    background: "var(--wp-dark)",
  };
}

// Wrapper inside the right-pane <section> for empty/composer/reader.
// flex:1 + minHeight:0 lets each child fill the available column.
const paneFill: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

// Reader-specific wrapper. Same fill behavior as paneFill, plus a
// scroll boundary so long emails scroll inside the right pane
// instead of the whole page. Mirrors the previous full-screen
// reader wrapper but scoped to the right column.
const readerWrap: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflowX: "hidden",
  overflowY: "auto",
  background: "var(--wp-dark)",
};

const composerWithDrawerWrap: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "row",
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  overflow: "hidden",
  minHeight: 0,
};

const composerWrap: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--wp-dark-surface)",
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

const signatureMenuStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 20,
  minWidth: 240,
  maxWidth: 320,
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 6,
  boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const signatureMenuItemStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderRadius: 4,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const signatureMenuPreviewStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--wp-text-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const signatureMenuEmptyStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--wp-text-dim)",
  padding: "0.5rem 0.6rem",
};

const signatureMenuManageStyle: React.CSSProperties = {
  display: "block",
  marginTop: 4,
  padding: "0.45rem 0.6rem",
  borderTop: "1px solid var(--wp-dark-border)",
  fontSize: "0.78rem",
  color: "var(--wp-gold)",
  textDecoration: "none",
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

/* actionsRow removed — replaced by .compose-actions in globals.css so a
   media query can stack the buttons full-width on <560px viewports. */

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
