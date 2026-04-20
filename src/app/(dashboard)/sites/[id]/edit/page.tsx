"use client";

/**
 * Sites — split-screen prompt-driven editor.
 *
 * Left pane: chat + diff of the last change; right pane: live iframe of
 * the brief rendered by /sites/[id]/preview. No deploys fire on prompt —
 * drafts update the iframe via a same-origin localStorage bridge + a
 * cache-busting reload. User clicks Publish to run the existing save +
 * deploy flow.
 *
 * Every action emits analytics (`trackEvent` server-side from the API;
 * the client also pings `/api/track` on mount, publish, discard). NO
 * orphan UI.
 */

import { useEffect, useMemo, useRef, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authHeaders,
  jsonHeaders,
  fetchWithRefresh,
  getInstinctToken,
} from "@/lib/client-auth";
import type { Brief } from "@/components/sites/BriefForm";
import ViewportToggle, {
  VIEWPORT_WIDTHS,
  type Viewport,
} from "@/components/sites/ViewportToggle";
import {
  INSTINCT_EDIT_ORIGIN,
  applyInlineEdit,
  applyInlineReorder,
  encodeBriefPush,
  isInstinctEditMessage,
  type InlineEditMessage,
} from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";
import AssetLibraryPicker, {
  type ClientAssetView,
} from "@/components/sites/AssetLibraryPicker";
import BrandUrlImporter from "@/components/sites/BrandUrlImporter";
import type { BrandThemeSuggestion } from "@/lib/brand-url-import";
import FigmaImporter from "@/components/sites/FigmaImporter";
import type { FigmaBriefSuggestion } from "@/lib/figma-import";
import VersionHistoryPanel, {
  type BriefVersionEntryView,
} from "@/components/sites/VersionHistoryPanel";
import CommentsPane from "@/components/sites/CommentsPane";
import type { SiteTheme } from "@/lib/site-theme";

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: Brief;
  status: string;
  preview_url: string | null;
}

interface JsonPatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

interface EditResponse {
  edit_id: string;
  patch: JsonPatchOp[];
  renderedBrief: Brief;
  explanation: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  patch?: JsonPatchOp[];
  editId?: string;
  timestamp: number;
}

const DRAFT_STORAGE_KEY = (projectId: string) => `instinct_draft_${projectId}`;

/**
 * Cheap non-cryptographic content hash for a brief. We don't need
 * collision resistance — just a stable string that changes whenever the
 * brief content changes, so we can detect stale localStorage drafts
 * after the saved brief moved forward server-side.
 */
function hashBrief(b: unknown): string {
  const s = JSON.stringify(b);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

interface StoredDraft {
  brief: Brief;
  /**
   * Hash of the SAVED brief at the time this draft was written. Used to
   * auto-discard when the server-side brief has been updated since.
   * Missing field = legacy draft from before this guard — always discarded.
   */
  savedHashAtWrite?: string;
  /** ms timestamp for future time-based TTLs; informational today. */
  writtenAt?: number;
}

// ---------------------------------------------------------------------------
// Extracted pure helpers (unit-testable without mounting the page).
// `use(params: Promise)` suspends in jsdom; RTL never ticks. Helpers live
// here so the error-mapping contract + dirty computation can be pinned in
// jest without a full render. Full-flow coverage sits in the Playwright
// E2E spec (tests/e2e/sites-edit-flow.spec.ts).
// ---------------------------------------------------------------------------

export interface BriefEditErrorPayload {
  error?: string;
  reason?: string;
  blockedPaths?: string[];
}

export function mapEditError(data: BriefEditErrorPayload): string {
  const reason = data.reason ?? "unknown";
  if (reason === "patch_blocked") {
    return `Edit refused — it tried to change protected fields: ${(data.blockedPaths ?? []).join(", ")}.`;
  }
  if (reason === "ai_not_configured") {
    // Use the server's own message — it names the env var + who to ask
    // + what to do in the meantime. Don't replace with a vague retry.
    return (
      data.error ??
      "The AI brief editor is not configured. An admin must set ANTHROPIC_API_KEY in Vercel. Until then, edit the brief via the form on the detail page."
    );
  }
  if (reason === "ai_unavailable") {
    return "The edit model is unavailable right now. Try again in a moment.";
  }
  return data.error ?? "Edit failed.";
}

export function briefsDiffer(a: Brief | null, b: Brief | null): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Read the current value of a field from a brief — used to compute
 * char_delta on inline text edits so the learning loop can see whether
 * designers are shortening or expanding AI-generated copy. Safe for
 * malformed briefs: returns "" for any missing path.
 */
/**
 * Pure handler for inline-edit messages arriving from the preview
 * iframe. Exported so the RTL test can exercise it without mounting
 * the full edit page (which suspends on `use(params)` in jsdom).
 *
 * Returns `null` for messages that should not mutate state (unknown
 * origin, untrusted source, invalid shape, no-op edit). Otherwise
 * returns the next draft + the analytics event to fire.
 *
 * Security contract:
 *   - `expectedOrigin` must equal the event's `origin`.
 *   - `expectedSource` must be the specific `iframeContentWindow` we
 *     mounted. Anything else is dropped silently.
 */
export function handleInlineEditMessage(args: {
  event: Pick<MessageEvent, "origin" | "source" | "data">;
  expectedOrigin: string;
  expectedSource: unknown;
  currentDraft: SiteBrief | null;
  siteId: string;
}): {
  nextDraft: SiteBrief | null;
  analytics: {
    event:
      | "site.inline_text_edited"
      | "site.inline_cta_edited"
      | "site.section_reordered";
    metadata: Record<string, unknown>;
  } | null;
  hover: { sectionType: string; route: string } | null;
} | null {
  const { event, expectedOrigin, expectedSource, currentDraft, siteId } = args;
  if (event.origin !== expectedOrigin) return null;
  if (event.source !== expectedSource) return null;
  if (!isInstinctEditMessage(event.data)) return null;
  const msg = event.data;
  if (msg.type === "hover") {
    const route =
      currentDraft?.pages?.[msg.pageIndex]?.route ?? "/";
    return { nextDraft: null, analytics: null, hover: { sectionType: msg.sectionType, route } };
  }
  if (msg.type === "section.reorder") {
    if (!currentDraft) return null;
    const nextBrief = applyInlineReorder(currentDraft, msg);
    // applyInlineReorder returns the original reference on no-op / invalid
    // indices — a referential compare is enough, no need to stringify.
    if (nextBrief === currentDraft) return null;
    // Capture the moved section's TYPE before move so the learning loop
    // can ask "what section type did the designer promote / demote?"
    // without needing to diff the before/after briefs itself.
    const movedSection =
      currentDraft.pages?.[msg.pageIndex]?.sections?.[msg.fromIndex];
    const sectionTypeMoved = movedSection?.type ?? "unknown";
    return {
      nextDraft: nextBrief,
      analytics: {
        event: "site.section_reordered",
        metadata: {
          site_id: siteId,
          page_index: msg.pageIndex,
          section_type_moved: sectionTypeMoved,
          from_index: msg.fromIndex,
          to_index: msg.toIndex,
          // Signed distance: positive = designer moved the section DOWN
          // (later in the page flow), negative = UP (promoted toward the
          // top). The learning loop clusters by sign to surface "this
          // client always promotes testimonials above pricing" patterns.
          move_distance: msg.toIndex - msg.fromIndex,
        },
      },
      hover: null,
    };
  }
  if (msg.type !== "text.edit" && msg.type !== "cta.edit") return null;
  if (!currentDraft) return null;
  const nextBrief = applyInlineEdit(currentDraft, msg);
  if (nextBrief === currentDraft) return null;
  if (JSON.stringify(nextBrief) === JSON.stringify(currentDraft)) return null;

  if (msg.type === "text.edit") {
    const oldVal = readFieldValue(currentDraft, msg);
    const newLen = msg.value.length;
    const oldLen = typeof oldVal === "string" ? oldVal.length : 0;
    const sectionType =
      currentDraft.pages?.[msg.pageIndex]?.sections?.[msg.sectionIndex]?.type ??
      "unknown";
    return {
      nextDraft: nextBrief,
      analytics: {
        event: "site.inline_text_edited",
        metadata: {
          site_id: siteId,
          section_type: sectionType,
          field: msg.field,
          char_delta: newLen - oldLen,
        },
      },
      hover: null,
    };
  }
  return {
    nextDraft: nextBrief,
    analytics: {
      event: "site.inline_cta_edited",
      metadata: { site_id: siteId, field: msg.field },
    },
    hover: null,
  };
}

export function readFieldValue(
  brief: SiteBrief,
  msg: Extract<InlineEditMessage, { type: "text.edit" }>,
): string {
  const section =
    brief.pages?.[msg.pageIndex]?.sections?.[msg.sectionIndex];
  if (!section) return "";
  if (msg.field === "tagline") return brief.product?.tagline ?? "";
  if (typeof msg.itemIndex === "number") {
    const item = section.items?.[msg.itemIndex];
    if (!item) return "";
    if (msg.field === "quote") return item.quote ?? "";
    if (msg.field === "body") return item.body ?? "";
    if (msg.field === "attribution") return item.authorName ?? "";
  }
  if (msg.field === "heading") return section.heading ?? "";
  if (msg.field === "body") return section.body ?? "";
  if (msg.field === "quote") return section.body ?? "";
  if (msg.field === "attribution") return section.attribution ?? "";
  return "";
}

function trackClient(eventName: string, metadata: Record<string, unknown>) {
  // POST to /api/analytics via fetchWithRefresh so a 401 rotates the
  // JWT instead of silently dropping the event. Must not throw — a
  // dead analytics POST cannot break the editor UX.
  if (typeof window === "undefined") return;
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      event: eventName,
      metadata: {
        ...metadata,
        page: window.location.pathname,
      },
    }),
  }).catch(() => {
    /* non-fatal — analytics must never break UX */
  });
}

export default function SiteEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [project, setProject] = useState<SiteProject | null>(null);
  const [savedBrief, setSavedBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState<Brief | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Transient label shown at the top of the chat pane header — "Hovering:
  // hero on /" — so designers know which section the cursor is on
  // without entering inline-edit mode. Cheap UX win per Path C Phase 1.
  const [hoveredSection, setHoveredSection] = useState<{
    sectionType: string;
    route: string;
  } | null>(null);
  // Keep a ref to the latest draft so the postMessage handler (which is
  // registered once) always applies edits to the freshest state. Avoids
  // stale-closure bugs where a second inline edit reverts the first.
  const draftRef = useRef<Brief | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Responsive viewport toggle — Mobile / Tablet / Desktop. Persisted to
  // the URL as ?viewport=... so refresh + deep-links survive. Default is
  // desktop per spec. Reading window.location directly (instead of
  // useSearchParams) keeps this component test-friendly in jsdom and
  // doesn't pull in extra `<Suspense>` boundaries.
  const [viewport, setViewportState] = useState<Viewport>("desktop");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("viewport");
    if (param === "mobile" || param === "tablet" || param === "desktop") {
      setViewportState(param);
    }
  }, []);
  function setViewport(next: Viewport) {
    const prev = viewport;
    if (prev === next) return;
    setViewportState(next);
    // Mirror to URL so refresh / deep-link survives. `replaceState` keeps
    // history uncluttered — the designer clicking Mobile 20 times should
    // not pollute browser history with 20 back entries.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("viewport", next);
      window.history.replaceState({}, "", url.toString());
    }
    // Feed the learning loop: which viewports do designers actually use
    // per client? The learning view can surface auto-default selections
    // over time (e.g. "this client's designers spend 70% of edit time in
    // Mobile — open in Mobile next time").
    trackClient("site.viewport_changed", {
      site_id: id,
      from: prev,
      to: next,
    });
  }

  // Auth gate — redirect to login if no token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = getInstinctToken();
    if (!token) {
      window.location.href = `/login?next=/sites/${id}/edit`;
    }
  }, [id]);

  // Load the saved project.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
        if (!r.ok) {
          setError(`Could not load site (HTTP ${r.status}).`);
          return;
        }
        const data = (await r.json()) as { project: SiteProject };
        setProject(data.project);
        setSavedBrief(data.project.brief);
        // Restore any in-progress draft from localStorage IF it's still
        // fresh — i.e. the saved brief hasn't moved forward server-side
        // since the draft was written. Legacy drafts (pre-staleness
        // guard) and drafts identical to the saved brief are silently
        // discarded so the "Restored draft" banner only ever shows when
        // there's a real uncommitted change worth restoring.
        const savedHashNow = hashBrief(data.project.brief);
        const stored = localStorage.getItem(DRAFT_STORAGE_KEY(id));
        let restored = false;
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as Brief | StoredDraft;
            const isStoredDraft =
              parsed !== null &&
              typeof parsed === "object" &&
              "brief" in (parsed as object);
            const storedBrief = isStoredDraft
              ? (parsed as StoredDraft).brief
              : (parsed as Brief);
            const storedHash = isStoredDraft
              ? (parsed as StoredDraft).savedHashAtWrite
              : undefined;
            const draftIsIdentical =
              JSON.stringify(storedBrief) === JSON.stringify(data.project.brief);
            const draftIsStale =
              storedHash === undefined || storedHash !== savedHashNow;
            if (!draftIsIdentical && !draftIsStale) {
              setDraft(storedBrief);
              setMessages([
                {
                  id: "restore",
                  role: "system",
                  text: "Restored an in-progress draft from your last session. Publish or Discard to reset.",
                  timestamp: Date.now(),
                },
              ]);
              restored = true;
            } else {
              // Silent auto-discard — the stored draft is either stale
              // (saved brief moved forward) or a no-op duplicate.
              localStorage.removeItem(DRAFT_STORAGE_KEY(id));
            }
          } catch {
            localStorage.removeItem(DRAFT_STORAGE_KEY(id));
          }
        }
        if (!restored) {
          setDraft(data.project.brief);
        }
        trackClient("site.edit_opened", { project_id: id });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
     
  }, [id]);

  // Persist draft to localStorage + nudge iframe on every change.
  useEffect(() => {
    if (!draft) return;
    try {
      // Write the new envelope shape including a hash of the SAVED
      // brief at write time. On next load, if the saved brief has
      // moved forward (hash mismatch), the stored draft is auto-
      // discarded rather than restored over fresher server content.
      const envelope: StoredDraft = {
        brief: draft,
        savedHashAtWrite: savedBrief ? hashBrief(savedBrief) : undefined,
        writtenAt: Date.now(),
      };
      localStorage.setItem(DRAFT_STORAGE_KEY(id), JSON.stringify(envelope));
    } catch {
      // storage quota — non-fatal; iframe falls back to saved brief
    }
    // Push to iframe via postMessage (fast path). Also bump nonce to reload
    // iframe — belt-and-suspenders in case the preview page hasn't wired
    // up the listener yet.
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "instinct:brief-update", brief: draft },
        window.location.origin,
      );
    } catch {
      /* non-fatal */
    }
    // Path C / Stream P2 fast-path: push a typed brief.push message so
    // the inline-edit overlay can re-render without a URL-hash reload.
    // Payload-capped at 64KB; when exceeded we fall back to the nonce
    // bump which forces a fresh iframe load.
    try {
      const encoded = encodeBriefPush(draft);
      if (encoded) {
        iframeRef.current?.contentWindow?.postMessage(
          JSON.parse(encoded),
          window.location.origin,
        );
      }
    } catch {
      /* non-fatal */
    }
  }, [draft, id, savedBrief]);

  // Stream P2 inline-edit listener. Designers click any editable text /
  // CTA inside the preview iframe → the overlay postMessages here →
  // applyInlineEdit merges the change into `draft`. The draft effect
  // above then pushes the updated brief back for re-render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onMessage(event: MessageEvent) {
      // SECURITY: origin + source gate. Only the preview iframe we just
      // mounted may send inline-edit messages. Silently drop everything
      // else so extensions / dev tools / third-party iframes can't poke
      // at our state.
      if (event.origin !== window.location.origin) return;
      if (!iframeRef.current) return;
      if (event.source !== iframeRef.current.contentWindow) return;
      if (!isInstinctEditMessage(event.data)) return;
      const msg = event.data;
      if (msg.type === "hover") {
        const route = draftRef.current?.pages?.[msg.pageIndex]?.route ?? "/";
        setHoveredSection({ sectionType: msg.sectionType, route });
        return;
      }
      if (msg.type === "section.reorder") {
        const current = draftRef.current;
        if (!current) return;
        const nextBrief = applyInlineReorder(current as SiteBrief, msg) as Brief;
        // applyInlineReorder returns the original ref on no-op / invalid
        // indices, so this ref-equal check is both the no-op guard AND
        // the "invalid indices" guard in one line. No render, no analytics.
        if (nextBrief === (current as SiteBrief)) return;
        const movedSection = (current as SiteBrief).pages?.[msg.pageIndex]
          ?.sections?.[msg.fromIndex];
        const sectionTypeMoved = movedSection?.type ?? "unknown";
        setDraft(nextBrief);
        trackClient("site.section_reordered", {
          site_id: id,
          page_index: msg.pageIndex,
          section_type_moved: sectionTypeMoved,
          from_index: msg.fromIndex,
          to_index: msg.toIndex,
          move_distance: msg.toIndex - msg.fromIndex,
        });
        return;
      }
      if (msg.type === "text.edit" || msg.type === "cta.edit") {
        const current = draftRef.current;
        if (!current) return;
        const nextBrief = applyInlineEdit(current as SiteBrief, msg) as Brief;
        // Only update + fire analytics if the value actually changed.
        if (JSON.stringify(nextBrief) === JSON.stringify(current)) return;
        setDraft(nextBrief);

        if (msg.type === "text.edit") {
          const oldVal = readFieldValue(current as SiteBrief, msg);
          const newLen = msg.value.length;
          const oldLen = typeof oldVal === "string" ? oldVal.length : 0;
          const sectionType =
            (current as SiteBrief)?.pages?.[msg.pageIndex]?.sections?.[
              msg.sectionIndex
            ]?.type ?? "unknown";
          trackClient("site.inline_text_edited", {
            site_id: id,
            section_type: sectionType,
            field: msg.field,
            char_delta: newLen - oldLen,
          });
        } else {
          trackClient("site.inline_cta_edited", {
            site_id: id,
            field: msg.field,
          });
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  const dirty = useMemo(() => {
    if (!draft || !savedBrief) return false;
    return JSON.stringify(draft) !== JSON.stringify(savedBrief);
  }, [draft, savedBrief]);

  async function sendPrompt() {
    if (!input.trim() || !draft) return;
    const instruction = input.trim();
    const userMsgId = `u_${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: userMsgId, role: "user", text: instruction, timestamp: Date.now() },
    ]);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${id}/brief-edit`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ instruction, brief: draft }),
      });
      const data = (await r.json()) as EditResponse & {
        error?: string;
        reason?: string;
        blockedPaths?: string[];
      };
      if (!r.ok) {
        // Route through mapEditError so all branches (patch_blocked,
        // ai_unavailable, ai_not_configured, fallback) stay in one
        // place. Keeps the UI + the contract test aligned.
        const msg = mapEditError(data);
        setMessages((m) => [
          ...m,
          {
            id: `e_${Date.now()}`,
            role: "assistant",
            text: msg,
            timestamp: Date.now(),
          },
        ]);
        setError(msg);
        return;
      }
      setDraft(data.renderedBrief);
      setMessages((m) => [
        ...m,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          text: data.explanation || "Applied your change.",
          patch: data.patch,
          editId: data.edit_id,
          timestamp: Date.now(),
        },
      ]);
      setIframeNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discardLast() {
    // Discard is what the user reaches for when they want to undo their
    // in-progress work. That "work" can be any of three things:
    //   - unsaved typing in the prompt input (common, what every user
    //     tries first)
    //   - an accumulated draft that diverges from the saved brief
    //   - a session full of assistant messages they don't want to keep
    // Pre-2026-04-18 we only handled #2 and bailed early if !savedBrief
    // or !dirty, so clicking Discard after just typing in the prompt
    // looked like a broken button. It now clears all three.
    const hadInput = input.length > 0;
    const wasDirty = dirty;
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);

    setInput("");
    if (savedBrief && wasDirty) {
      setDraft(savedBrief);
    }
    if (wasDirty) {
      localStorage.removeItem(DRAFT_STORAGE_KEY(id));
    }

    // Tell the backend the last edit was rejected so the learning loop
    // captures "user said no to this patch". Non-fatal — analytics and
    // the UI state always fire.
    if (lastAi?.editId) {
      fetchWithRefresh(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ accepted: false, rejectionReason: "user_discarded_all" }),
      }).catch(() => {
        /* non-fatal */
      });
    }

    const bannerText = wasDirty
      ? "Reverted to the last published brief."
      : hadInput
        ? "Cleared your typing."
        : "Nothing to discard — you're in sync with the last published deploy.";
    setMessages([
      {
        id: `discarded-${Date.now()}`,
        role: "system",
        text: bannerText,
        timestamp: Date.now(),
      },
    ]);
    trackClient("site.edit_discarded", {
      project_id: id,
      had_input: hadInput,
      had_dirty_draft: wasDirty,
      had_edit_id: !!lastAi?.editId,
    });
    if (wasDirty) setIframeNonce((n) => n + 1);
  }

  async function publish() {
    if (!draft || !dirty) return;
    setPublishing(true);
    setError(null);
    try {
      // 1. Save the brief via the existing PATCH handler
      const saveRes = await fetchWithRefresh(`/api/sites/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ brief: draft }),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (HTTP ${saveRes.status}).`);
      }
      // 2. Mark the last AI edit as accepted so learning sees the positive.
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);
      if (lastAi?.editId) {
        fetchWithRefresh(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ accepted: true }),
        }).catch(() => {
          /* non-fatal */
        });
      }
      // 3. Fire the deploy
      const depRes = await fetchWithRefresh(`/api/sites/${id}?action=deploy`, {
        method: "PATCH",
        headers: authHeaders(),
      });
      const depData = await depRes.json().catch(() => ({}));
      if (!depRes.ok) {
        throw new Error(depData.error ?? `Deploy failed (HTTP ${depRes.status}).`);
      }
      trackClient("site.edit_published", {
        project_id: id,
        deploy_id: (depData as { deployId?: string }).deployId,
        edits_in_session: messages.filter((m) => m.role === "assistant" && m.editId).length,
      });
      // 4. Reset — saved == draft now
      setSavedBrief(draft);
      localStorage.removeItem(DRAFT_STORAGE_KEY(id));
      setMessages([
        {
          id: `pub_${Date.now()}`,
          role: "system",
          text: "Published. Deploy started — preview will rebuild in ~3 minutes.",
          timestamp: Date.now(),
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  if (!project || !draft) {
    return (
      <main style={{ padding: 40, color: "var(--wp-fg, #e6e6e6)" }}>
        {error ? <p style={{ color: "#e07070" }}>{error}</p> : <p>Loading editor…</p>}
      </main>
    );
  }

  // Preview URL: encode the current draft as base64 so the iframe renders
  // the in-memory state without a save/deploy round-trip. Falls back to
  // the saved brief if the payload is too large (>256KB cap on the
  // preview page); for realistic briefs this never hits.
  const previewUrl = (() => {
    try {
      const encoded =
        typeof btoa === "function"
          ? btoa(unescape(encodeURIComponent(JSON.stringify(draft))))
          : Buffer.from(JSON.stringify(draft), "utf-8").toString("base64");
      if (encoded.length > 256 * 1024) {
        // Draft is enormous — fall back to saved brief.
        return `/sites/${id}/preview?t=${iframeNonce}`;
      }
      return `/sites/${id}/preview?draft=${encodeURIComponent(encoded)}&t=${iframeNonce}`;
    } catch {
      return `/sites/${id}/preview?t=${iframeNonce}`;
    }
  })();

  return (
    <main
      style={{
        display: "grid",
        // Widened from 420 → 520 on 2026-04-19 after the designer reported
        // the left column feeling cramped with all the nested panels
        // (Assets, Brand URL, SEO, Domain, Share). clamp so we don't
        // crush the right-pane preview on narrow laptops.
        gridTemplateColumns: "clamp(420px, 38vw, 560px) 1fr",
        height: "calc(100vh - 64px)",
        gap: 0,
        color: "var(--wp-fg, #e6e6e6)",
        background: "var(--wp-bg, #0f1115)",
      }}
    >
      {/* LEFT — chat + publish controls. Each <details> panel below gets
          position:relative + stacking isolation via CSS scoped to this
          pane so native <select> popups render ABOVE neighbouring panels
          instead of kissing their borders. */}
      <style>{`
        [data-testid="edit-chat-pane"] details {
          position: relative;
          isolation: isolate;
          z-index: 1;
          margin-bottom: 14px;
        }
        [data-testid="edit-chat-pane"] details[open] {
          z-index: 2;
        }
        [data-testid="edit-chat-pane"] details > summary {
          padding: 8px 10px;
          margin: -8px -10px;
          border-radius: 6px;
        }
        [data-testid="edit-chat-pane"] select,
        [data-testid="edit-chat-pane"] input[type="text"],
        [data-testid="edit-chat-pane"] input[type="search"],
        [data-testid="edit-chat-pane"] input[type="url"],
        [data-testid="edit-chat-pane"] input[type="email"] {
          min-width: 0;
        }
        [data-testid="edit-chat-pane"] .panel-row {
          display: flex;
          gap: 10px;
          align-items: stretch;
        }
      `}</style>
      <section
        style={{
          borderRight: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
        data-testid="edit-chat-pane"
      >
        <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          {/* Breadcrumbs: Sites list ← client name ← Edit. Without these
              the editor was a dead end — the user could not get back to
              the detail page or the list without hitting the browser
              back button or clicking the sidebar. */}
          <nav
            aria-label="Breadcrumb"
            data-testid="edit-breadcrumbs"
            style={{ fontSize: 12, opacity: 0.7, marginBottom: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
          >
            <Link
              href="/sites"
              data-testid="edit-breadcrumb-sites"
              style={{ color: "var(--wp-text-dim, #8a8a8a)", textDecoration: "none" }}
            >
              ← Sites
            </Link>
            <span style={{ opacity: 0.4 }}>/</span>
            <Link
              href={`/sites/${id}`}
              data-testid="edit-breadcrumb-detail"
              style={{ color: "var(--wp-text-dim, #8a8a8a)", textDecoration: "none" }}
            >
              {project.client_slug}
            </Link>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{ color: "var(--wp-text, #e6e6e6)" }}>Edit</span>
          </nav>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0" }}>
            {project.display_name}
          </h1>
          {hoveredSection ? (
            <div
              data-testid="edit-hover-indicator"
              style={{
                marginTop: 4,
                fontSize: 11,
                opacity: 0.65,
                color: "var(--wp-accent, #f3b841)",
              }}
            >
              Hovering: {hoveredSection.sectionType} on {hoveredSection.route}
            </div>
          ) : null}
          <div style={{ marginTop: 8, display: "flex", gap: 12, fontSize: 12 }}>
            <Link
              href={`/sites/${id}`}
              data-testid="edit-back-to-detail"
              style={{
                color: "var(--wp-accent, #f3b841)",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              ← Back to site detail
            </Link>
            {project.preview_url && (
              <a
                href={project.preview_url}
                target="_blank"
                rel="noreferrer"
                data-testid="edit-open-preview"
                style={{
                  color: "var(--wp-accent, #f3b841)",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                Open live preview ↗
              </a>
            )}
          </div>
        </header>

        <div
          style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}
          data-testid="edit-chat-messages"
        >
          {messages.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 14, padding: "24px 0" }}>
              Describe any change you want to make. The preview updates on the right.
              Example: <em>&quot;Change the hero headline to &apos;Season One&apos;.&quot;</em>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: "8px 12px",
                  margin: "4px 0",
                  borderRadius: 8,
                  background:
                    m.role === "user"
                      ? "rgba(80, 140, 220, 0.08)"
                      : m.role === "assistant"
                        ? "rgba(80, 200, 120, 0.06)"
                        : "rgba(255,255,255,0.04)",
                  border:
                    m.role === "user"
                      ? "1px solid rgba(80, 140, 220, 0.25)"
                      : m.role === "assistant"
                        ? "1px solid rgba(80, 200, 120, 0.2)"
                        : "1px solid rgba(255,255,255,0.08)",
                  fontSize: 14,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2 }}>
                  {m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : "System"}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                {m.patch && m.patch.length > 0 && (
                  <details style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                    <summary style={{ cursor: "pointer" }}>{m.patch.length} change(s)</summary>
                    <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
                      {m.patch.map((op, i) => (
                        <li key={i}>
                          <code>{op.op}</code> <code>{op.path}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            padding: 16,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {error && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(220, 80, 80, 0.08)",
                border: "1px solid rgba(220, 80, 80, 0.3)",
                borderRadius: 6,
                fontSize: 12,
                color: "#e07070",
              }}
              data-testid="edit-error-banner"
            >
              {error}
            </div>
          )}
          <label htmlFor="edit-prompt-input" style={{ position: "absolute", left: "-9999px" }}>
            Describe a change to the site
          </label>
          <textarea
            id="edit-prompt-input"
            name="edit-prompt-input"
            data-testid="edit-prompt-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder="Describe a change. Cmd/Ctrl+Enter to send."
            rows={3}
            disabled={busy || publishing}
            aria-label="Describe a change to the site"
            style={{
              width: "100%",
              padding: 10,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              color: "inherit",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="edit-send-btn"
              onClick={() => void sendPrompt()}
              disabled={busy || publishing || !input.trim()}
              style={{
                flex: 1,
                padding: "10px 12px",
                background: busy ? "rgba(255,255,255,0.04)" : "var(--wp-accent, #f3b841)",
                color: busy ? "var(--wp-fg)" : "#111",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Thinking…" : "Send"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="edit-publish-btn"
              onClick={() => void publish()}
              disabled={!dirty || busy || publishing}
              style={{
                flex: 1,
                padding: "8px 12px",
                background: dirty ? "rgba(80, 200, 120, 0.16)" : "rgba(255,255,255,0.04)",
                border: dirty ? "1px solid rgba(80, 200, 120, 0.4)" : "1px solid rgba(255,255,255,0.12)",
                color: dirty ? "#6dcf85" : "rgba(255,255,255,0.45)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: dirty && !publishing ? "pointer" : "default",
              }}
            >
              {publishing ? "Publishing…" : dirty ? "Publish" : "No changes to publish"}
            </button>
            <button
              data-testid="edit-discard-btn"
              onClick={() => void discardLast()}
              // Enabled when there's ANYTHING to discard — unsaved
              // typing in the prompt OR a dirty draft OR assistant
              // messages from the current session. Leaving it disabled
              // when the user typed "hello" in the prompt but hadn't
              // sent it made the button look dead.
              disabled={(!dirty && input.length === 0 && messages.length === 0) || busy || publishing}
              style={{
                padding: "8px 12px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "inherit",
                borderRadius: 6,
                fontSize: 13,
                cursor: dirty && !publishing ? "pointer" : "default",
              }}
            >
              Discard
            </button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.5 }}>
            {dirty ? "Draft — not yet published." : "In sync with last published deploy."}
          </div>
        </div>

        {/* Asset Library panel (Path C Phase 1, Stream P3). Collapsed
            by default so it doesn't eat vertical space on the chat pane
            for designers who don't need it. onPick copies the canonical
            URL to the clipboard for paste-into-brief; full postMessage
            swap into the iframe is the follow-up once P2's bridge ships. */}
        <details
          data-testid="asset-library-panel"
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            padding: 16,
          }}
        >
          <summary
            style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            data-testid="asset-library-toggle"
          >
            Assets
          </summary>
          <div style={{ marginTop: 12 }}>
            <AssetLibraryPicker
              clientSlug={project.client_slug}
              onPick={(asset: ClientAssetView) => {
                // v1: copy the canonical URL so the designer can paste it
                // into any image field in the chat prompt. Full inline
                // image swap hooks into P2's postMessage bridge in a
                // follow-up commit — intentionally out of scope here.
                try {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    navigator.clipboard.writeText(asset.url).catch(() => {});
                  }
                } catch {
                  /* non-fatal */
                }
                trackClient("client_asset_reused", {
                  client_slug: asset.clientSlug,
                  asset_id: asset.id,
                  site_id: id,
                  kind: asset.assetKind,
                });
              }}
            />
          </div>
        </details>

        {/* Brand URL Importer panel (Path C Phase 2, Stream Q2). The
            designer pastes the client's existing public website and we
            seed the brief's theme tokens from the scrape. Merges the
            suggestion into `draft.theme` so the preview updates live
            and the Publish button becomes available. */}
        <details
          data-testid="brand-url-importer-panel"
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            padding: 16,
          }}
        >
          <summary
            style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            data-testid="brand-url-importer-toggle"
          >
            Seed from existing site URL
          </summary>
          <div style={{ marginTop: 12 }}>
            <BrandUrlImporter
              siteId={id}
              onApply={(suggestion: BrandThemeSuggestion) => {
                // Merge scraped theme tokens into the current draft's
                // theme. We never blow away fields the designer already
                // edited — the suggestion only fills in what's empty /
                // undefined. If the designer wants the full overwrite
                // they can keep editing from here.
                const current = draftRef.current;
                if (!current) return;
                const curTheme = (current.theme ?? {}) as SiteTheme;
                const mergedColors = {
                  ...(curTheme.colors ?? {}),
                  ...(suggestion.colors ?? {}),
                };
                const mergedFont = suggestion.font?.family
                  ? { ...(curTheme.font ?? {}), family: suggestion.font.family }
                  : curTheme.font;
                const nextBrief: Brief = {
                  ...current,
                  theme: {
                    ...curTheme,
                    colors: mergedColors,
                    ...(mergedFont ? { font: mergedFont } : {}),
                  } as SiteTheme,
                };
                setDraft(nextBrief);
              }}
            />
          </div>
        </details>

        {/* Figma Importer panel (Path C Phase 3, Stream R1). Same shape
            as the BrandUrlImporter — paste a Figma file URL, Instinct
            pulls the file's palette + fonts + frame structure via the
            Figma REST API, and we merge the suggestion non-destructively
            into the draft. Existing theme fields always win; Figma fills
            in the gaps and adds any missing pages derived from frames. */}
        <details
          data-testid="figma-importer-panel"
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            padding: 16,
          }}
        >
          <summary
            style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            data-testid="figma-importer-toggle"
          >
            Seed from Figma file
          </summary>
          <div style={{ marginTop: 12 }}>
            <FigmaImporter
              siteId={id}
              onApply={(suggestion: FigmaBriefSuggestion) => {
                // Non-destructive merge. Existing theme fields win so a
                // designer who's already picked colors doesn't get them
                // stomped on by a fresh import. Pages from Figma are
                // appended only when their route isn't already present
                // in the draft.
                const current = draftRef.current;
                if (!current) return;
                const curTheme = (current.theme ?? {}) as SiteTheme;
                const incomingColors = suggestion.theme?.colors ?? {};
                const existingColors = curTheme.colors ?? {};
                // Merge: Figma fills empty slots only.
                const mergedColors = { ...existingColors };
                for (const [k, v] of Object.entries(incomingColors)) {
                  if (v && !(mergedColors as Record<string, string>)[k]) {
                    (mergedColors as Record<string, string>)[k] = v as string;
                  }
                }
                const mergedFont =
                  suggestion.theme?.font?.family && !curTheme.font?.family
                    ? {
                        ...(curTheme.font ?? {}),
                        family: suggestion.theme.font.family,
                      }
                    : curTheme.font;
                const existingRoutes = new Set(
                  (current.pages ?? []).map((p) => p.route),
                );
                const extraPages =
                  suggestion.pages?.filter(
                    (p) => !existingRoutes.has(p.route),
                  ) ?? [];
                const nextBrief: Brief = {
                  ...current,
                  theme: {
                    ...curTheme,
                    colors: mergedColors,
                    ...(mergedFont ? { font: mergedFont } : {}),
                  } as SiteTheme,
                  pages: [
                    ...(current.pages ?? []),
                    // Figma pages arrive as `{ route, title, sections }`
                    // with `sections: unknown[]` — the Figma library
                    // keeps that weakened typing because each section's
                    // validity is governed by BriefSection's own rules.
                    // We cast here because the merge step is the narrow
                    // point that makes the composite shape concrete.
                    ...(extraPages as unknown as Brief["pages"]),
                  ],
                };
                setDraft(nextBrief);
              }}
            />
          </div>
        </details>

        {/* Version History panel (Path C Phase 3, Stream R2).
            Unifies instinct_site_brief_generations + instinct_site_brief_edits
            into one timeline. Collapsed by default; GET fires on first
            expand so the page-load path stays cheap. Restore hydrates
            the edit draft + iframe without a round-trip refetch. */}
        <VersionHistoryPanel
          siteId={id}
          currentBrief={savedBrief as SiteBrief | null}
          onRestore={(entry: BriefVersionEntryView) => {
            // Server already wrote instinct_site_projects.brief + audit row.
            // Reflect the restored state locally so the iframe + draft
            // re-render immediately without a second GET /api/sites/:id.
            const restoredBrief = entry.brief as Brief;
            setSavedBrief(restoredBrief);
            setDraft(restoredBrief);
            setProject((prev) =>
              prev ? { ...prev, brief: restoredBrief } : prev,
            );
            // Bump the iframe so the preview reloads the updated brief.
            setIframeNonce((n) => n + 1);
          }}
        />

        {/* Comments pane (Path C Phase 3, Stream R3). Threaded per-
            section review comments — open + resolved + all. Clicking a
            comment posts comment.focus to the preview iframe so the
            designer sees which section was targeted. Resolve, reply,
            and soft-delete are all routed through authed APIs. */}
        <CommentsPane siteId={id} previewIframeRef={iframeRef} />
      </section>

      {/* RIGHT — live preview iframe, wrapped so we can simulate a
          device-width responsive preview without leaving the editor. */}
      <section
        style={{
          position: "relative",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "rgba(0,0,0,0.25)",
        }}
        data-testid="edit-preview-pane"
        data-viewport={viewport}
      >
        <header
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
          data-testid="edit-preview-header"
        >
          <div style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>
            Preview · {VIEWPORT_WIDTHS[viewport]}px
          </div>
          <ViewportToggle value={viewport} onChange={setViewport} />
        </header>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            justifyContent: "center",
            padding: viewport === "desktop" ? 0 : 16,
          }}
          data-testid="edit-preview-canvas"
        >
          <div
            data-testid="edit-preview-frame-wrapper"
            style={{
              width: "100%",
              maxWidth: `${VIEWPORT_WIDTHS[viewport]}px`,
              // CSS transition so width changes animate. 200ms is fast
              // enough to feel snappy; slower makes the preview feel laggy.
              transition: "max-width 200ms ease",
              height: "100%",
              // Subtle device-frame outline for mobile/tablet so the
              // designer visually perceives "this is a phone/tablet sim".
              // Desktop uses no frame — it's the default rendering.
              border:
                viewport === "desktop"
                  ? "none"
                  : "1px solid var(--wp-border, rgba(255,255,255,0.12))",
              borderRadius: viewport === "desktop" ? 0 : 8,
              overflow: "hidden",
              background: "#fff",
              boxShadow:
                viewport === "desktop" ? "none" : "0 2px 12px rgba(0,0,0,0.25)",
            }}
          >
            <iframe
              ref={iframeRef}
              key={iframeNonce /* force re-render when we bump */}
              src={previewUrl}
              title="Live preview"
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "#fff",
                display: "block",
              }}
              data-testid="edit-preview-iframe"
              /*
               * DON'T set `sandbox` here. Chrome warns when an iframe has
               * BOTH `allow-same-origin` AND `allow-scripts` because the
               * sandboxed content can script its way out of the sandbox —
               * which is the classic bypass pattern. The preview page
               * lives on the same origin (wolfpack-instinct.vercel.app)
               * and frame-ancestors 'self' already gates who can embed
               * it, so a sandbox here is defense-theater, not defense-in-
               * depth.
               */
            />
          </div>
        </div>
      </section>
    </main>
  );
}
