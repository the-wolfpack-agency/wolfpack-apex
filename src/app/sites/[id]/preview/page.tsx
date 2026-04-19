"use client";

/**
 * Sites preview — iframed by both /sites/[id] (detail) and
 * /sites/[id]/edit (prompt editor). Three render paths:
 *
 *   1. ?draft=<base64(JSON)>  → RenderBrief of the in-memory draft
 *                               (editor's unsaved pane).
 *   2. no draft, project.preview_url set → iframe the DEPLOYED Vercel
 *                                          URL served by wolfpack-site-
 *                                          template. This is the real
 *                                          styled site a client would
 *                                          see, including content
 *                                          sourced from wireframe
 *                                          uploads that live on the
 *                                          template side (not in
 *                                          SiteBrief).
 *   3. no draft, no preview_url → RenderBrief of the saved brief as a
 *                                  pre-deploy fallback so the editor
 *                                  never blanks.
 *
 * Parity: detail and edit iframes both point here, so whatever decision
 * this page makes renders identically in both surfaces.
 *
 * Analytics: fires `site.preview_viewed` on mount with
 *   { project_id, source, brief_section_count, has_preview_url }
 * `source` is one of "deployed" | "draft" | "fallback_saved" so the
 * learning loop can track how often operators see the real site vs the
 * internal renderer — a signal for template/brief drift health.
 */

import { useEffect, useMemo, useRef, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import {
  authHeaders,
  jsonHeaders,
  fetchWithRefresh,
  getInstinctToken,
} from "@/lib/client-auth";
import { validateBrief, type SiteBrief } from "@/lib/sites-schema";
import { RenderBrief } from "@/components/sites/render-brief";
import { buildSeoMetaTags, type SeoMetaTag } from "@/lib/seo-head";
import {
  INSTINCT_EDIT_ORIGIN,
  isInstinctEditMessage,
  type InlineEditMessage,
  type TextField,
} from "@/lib/preview-postmessage";

type PreviewSource = "deployed" | "draft" | "fallback_saved";

interface PreviewState {
  brief: SiteBrief | null;
  deployedUrl: string | null;
  source: PreviewSource;
  error: string | null;
  loading: boolean;
}

const MAX_DRAFT_BYTES = 256 * 1024;

export function decodeDraft(raw: string | null): { brief: SiteBrief | null; error: string | null } {
  if (!raw) return { brief: null, error: null };
  if (raw.length > MAX_DRAFT_BYTES) {
    return { brief: null, error: "Draft too large to preview (>256KB). Save the brief to preview." };
  }
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    let json: string;
    if (typeof atob === "function") {
      const bin = atob(normalized + pad);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      json = new TextDecoder("utf-8").decode(bytes);
    } else {
      json = Buffer.from(normalized + pad, "base64").toString("utf-8");
    }
    const parsed = JSON.parse(json) as unknown;
    validateBrief(parsed);
    return { brief: parsed as SiteBrief, error: null };
  } catch (err) {
    const msg = (err as Error).message || "Unknown draft error";
    return { brief: null, error: `Draft could not be rendered: ${msg}` };
  }
}

/**
 * Pure decision: given decoded draft + saved project fields, pick the
 * render path. Exported for unit tests so every branch is locked.
 */
export function selectPreviewSource(args: {
  draftBrief: SiteBrief | null;
  savedBrief: SiteBrief | null;
  previewUrl: string | null;
}): { source: PreviewSource; brief: SiteBrief | null; deployedUrl: string | null } {
  if (args.draftBrief) {
    return { source: "draft", brief: args.draftBrief, deployedUrl: null };
  }
  if (args.previewUrl && args.previewUrl.length > 0) {
    return { source: "deployed", brief: null, deployedUrl: args.previewUrl };
  }
  return { source: "fallback_saved", brief: args.savedBrief, deployedUrl: null };
}

export default function SitePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const draftRaw = searchParams?.get("draft") ?? null;
  const pageIndex = Number(searchParams?.get("page") ?? "0") || 0;

  const decodedDraft = useMemo(() => decodeDraft(draftRaw), [draftRaw]);

  const [state, setState] = useState<PreviewState>(() => {
    if (decodedDraft.brief) {
      return {
        brief: decodedDraft.brief,
        deployedUrl: null,
        source: "draft",
        error: null,
        loading: false,
      };
    }
    return {
      brief: null,
      deployedUrl: null,
      source: "fallback_saved",
      error: decodedDraft.error,
      loading: decodedDraft.error === null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    async function loadSaved() {
      if (decodedDraft.brief) return;

      const token = getInstinctToken();
      if (!token) {
        if (typeof window !== "undefined") {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?next=${next}`;
        }
        return;
      }

      try {
        const res = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) return;
        if (res.status === 404) {
          setState({
            brief: null,
            deployedUrl: null,
            source: "fallback_saved",
            error: "Site not found.",
            loading: false,
          });
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setState({
            brief: null,
            deployedUrl: null,
            source: "fallback_saved",
            error: data?.error ?? "Failed to load the saved brief.",
            loading: false,
          });
          return;
        }
        const savedBrief = (data.project?.brief ?? null) as SiteBrief | null;
        const previewUrl = (data.project?.preview_url ?? null) as string | null;
        const decision = selectPreviewSource({
          draftBrief: null,
          savedBrief,
          previewUrl,
        });
        setState({
          brief: decision.brief,
          deployedUrl: decision.deployedUrl,
          source: decision.source,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          brief: null,
          deployedUrl: null,
          source: "fallback_saved",
          error: (err as Error).message || "Preview request failed.",
          loading: false,
        });
      }
    }

    loadSaved();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, draftRaw]);

  // Analytics: every render path feeds the same event. source + has_preview_url
  // let the brain distinguish (a) how often operators see the real deployed
  // site vs the internal renderer and (b) brief/template drift health.
  useEffect(() => {
    if (state.loading) return;
    if (!state.brief && !state.deployedUrl) return;
    const sectionCount = state.brief
      ? (state.brief.pages ?? []).reduce((n, p) => n + (p.sections?.length ?? 0), 0)
      : 0;
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "site.preview_viewed",
        metadata: {
          project_id: id,
          source: state.source,
          brief_section_count: sectionCount,
          has_preview_url: Boolean(state.deployedUrl),
        },
      }),
    }).catch(() => {});
  }, [id, state.loading, state.brief, state.deployedUrl, state.source]);

  if (state.loading) {
    return (
      <div
        data-testid="preview-loading"
        className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500"
      >
        Loading preview…
      </div>
    );
  }

  if (state.error && !state.brief && !state.deployedUrl) {
    return (
      <div
        data-testid="preview-error"
        className="flex min-h-screen flex-col items-center justify-center gap-2 bg-white p-8 text-center"
      >
        <h2 className="text-lg font-semibold text-neutral-900">Preview unavailable</h2>
        <p className="max-w-md text-sm text-neutral-500">{state.error}</p>
      </div>
    );
  }

  if (state.source === "deployed" && state.deployedUrl) {
    return (
      <iframe
        data-testid="preview-root"
        data-preview-source="deployed"
        src={state.deployedUrl}
        title="Deployed site preview"
        style={{
          display: "block",
          width: "100%",
          height: "100vh",
          border: "none",
          background: "#fff",
        }}
      />
    );
  }

  if (!state.brief) {
    return (
      <div
        data-testid="preview-empty"
        className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500"
      >
        No brief to preview yet.
      </div>
    );
  }

  return (
    <div data-testid="preview-root" data-preview-source={state.source} className="bg-white">
      <SeoHeadInjector brief={state.brief} pageIndex={pageIndex} />
      <RenderBrief brief={state.brief} page={pageIndex} />
      <InlineEditOverlay
        brief={state.brief}
        pageIndex={pageIndex}
        onBriefPushed={(next) =>
          setState((s) => ({ ...s, brief: next, source: s.source }))
        }
      />
    </div>
  );
}

/* ---------------------------------------------------------------------- *
 * InlineEditOverlay — Path C Phase 1 / Stream P2                         *
 *                                                                        *
 * Designer clicks any editable text inside the rendered preview →        *
 * contentEditable span replaces the static node → on blur/Enter we       *
 * postMessage the new value up to the parent window. The parent merges   *
 * into its brief draft and pushes the new brief back via "brief.push",   *
 * which we apply to local state so the iframe re-renders without a       *
 * full reload.                                                           *
 *                                                                        *
 * Editability is gated on being INSIDE an iframe whose parent is         *
 * same-origin — otherwise the overlay no-ops and the preview renders     *
 * exactly like a public site. This is what keeps /sites/[id]/preview     *
 * safe to iframe from the detail page or to serve as a deployed          *
 * fallback: the overlay only wakes up in the editor surface.             *
 * ---------------------------------------------------------------------- */

const EDITABLE_SELECTORS: Record<
  string,
  Array<{ selector: string; field: TextField | "cta.label" | "cta.href" }>
> = {
  hero: [
    { selector: "h1", field: "heading" },
    { selector: "p", field: "body" },
    { selector: '[data-testid="hero-cta"]', field: "cta.label" },
  ],
  text: [
    { selector: "h2", field: "heading" },
    { selector: "p", field: "body" },
  ],
  quote: [
    { selector: "blockquote > p", field: "body" },
    { selector: "footer", field: "attribution" },
  ],
  callout: [
    { selector: "h3", field: "heading" },
    { selector: "aside > p", field: "body" },
    { selector: '[data-testid="callout-cta"]', field: "cta.label" },
  ],
  banner: [
    { selector: "h2", field: "heading" },
    { selector: "p", field: "body" },
    { selector: '[data-testid="banner-cta"]', field: "cta.label" },
  ],
};

const OVERLAY_HOVER_CLASS = "instinct-inline-editable-hover";
const OVERLAY_EDITING_CLASS = "instinct-inline-editing";

function parentIsSameOrigin(): boolean {
  if (typeof window === "undefined") return false;
  if (window.parent === window) return false;
  try {
    // Accessing window.parent.location.origin throws on cross-origin,
    // which is the signal we use — silently return false.
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function InlineEditOverlay({
  brief,
  pageIndex,
  onBriefPushed,
}: {
  brief: SiteBrief | null;
  pageIndex: number;
  onBriefPushed: (brief: SiteBrief) => void;
}) {
  const editingRef = useRef<HTMLElement | null>(null);
  const editingOriginalText = useRef<string>("");

  // Announce readiness and listen for brief.push only when we are
  // actually inside an editor iframe.
  useEffect(() => {
    if (!parentIsSameOrigin()) return;
    try {
      window.parent.postMessage(
        { origin: INSTINCT_EDIT_ORIGIN, type: "ready" } satisfies InlineEditMessage,
        window.location.origin,
      );
    } catch {
      /* non-fatal — parent might not be listening yet */
    }

    function onMessage(event: MessageEvent) {
      // SECURITY: origin + source gate. Drop anything that doesn't come
      // from the direct parent on the same origin. Third-party iframes
      // and extensions must never reach the handler below.
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      if (!isInstinctEditMessage(event.data)) return;
      if (event.data.type !== "brief.push") return;
      try {
        validateBrief(event.data.brief);
        onBriefPushed(event.data.brief as SiteBrief);
      } catch {
        // Invalid brief — drop silently. Parent remains source of truth
        // and the URL-hash draft path is still wired up as a fallback.
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onBriefPushed]);

  // Attach hover + click handlers to editable nodes AFTER render. We use
  // native DOM queries + event delegation so RenderBrief's section
  // renderers stay untouched (Stream P3 / P4 also subscribe without
  // touching them).
  useEffect(() => {
    if (!brief) return;
    if (typeof document === "undefined") return;
    if (!parentIsSameOrigin()) return;

    const root = document.querySelector('[data-testid="render-brief"]');
    if (!root) return;

    const sectionNodes = Array.from(
      root.querySelectorAll<HTMLElement>("[data-section-type]"),
    );
    const decorated: Array<{ el: HTMLElement; cleanup: () => void }> = [];
    let lastHoverSection = -1;

    sectionNodes.forEach((sectionEl, sectionIndex) => {
      const sectionType = sectionEl.dataset.sectionType ?? "";
      const entries = EDITABLE_SELECTORS[sectionType] ?? [];
      for (const entry of entries) {
        const target = sectionEl.querySelector<HTMLElement>(entry.selector);
        if (!target) continue;
        target.classList.add("instinct-inline-editable");
        target.dataset.instinctField = entry.field;
        target.dataset.instinctSectionIndex = String(sectionIndex);
        target.dataset.instinctPageIndex = String(pageIndex);

        const onEnter = () => {
          target.classList.add(OVERLAY_HOVER_CLASS);
          // Fire a hover event — sampled 1/5 client-side to keep the
          // analytics stream quiet. Use a stable hash so the same user
          // wiggling over a section doesn't spam.
          if (sectionIndex !== lastHoverSection && Math.random() < 0.2) {
            lastHoverSection = sectionIndex;
            try {
              window.parent.postMessage(
                {
                  origin: INSTINCT_EDIT_ORIGIN,
                  type: "hover",
                  pageIndex,
                  sectionIndex,
                  sectionType,
                } satisfies InlineEditMessage,
                window.location.origin,
              );
            } catch {
              /* non-fatal */
            }
          }
        };
        const onLeave = () => target.classList.remove(OVERLAY_HOVER_CLASS);
        const onClick = (ev: MouseEvent) => {
          // For CTA links, prevent navigation while editing.
          if (entry.field === "cta.label" || entry.field === "cta.href") {
            ev.preventDefault();
          }
          beginInlineEdit({
            el: target,
            pageIndex,
            sectionIndex,
            field: entry.field,
            editingRef,
            editingOriginalText,
          });
        };

        target.addEventListener("mouseenter", onEnter);
        target.addEventListener("mouseleave", onLeave);
        target.addEventListener("click", onClick);
        decorated.push({
          el: target,
          cleanup: () => {
            target.removeEventListener("mouseenter", onEnter);
            target.removeEventListener("mouseleave", onLeave);
            target.removeEventListener("click", onClick);
            target.classList.remove(OVERLAY_HOVER_CLASS);
            target.classList.remove("instinct-inline-editable");
          },
        });
      }
    });

    return () => decorated.forEach((d) => d.cleanup());
  }, [brief, pageIndex]);

  // Inline style tag for the dashed outline + cursor. Keeping it scoped
  // by a single className so we don't leak into the section CSS and so
  // we can keep the visual contract unit-testable (check the className,
  // the test env doesn't layout-paint).
  return (
    <style data-testid="instinct-inline-editable-style">{`
      .instinct-inline-editable { cursor: text; transition: outline 0.08s ease; }
      .${OVERLAY_HOVER_CLASS} {
        outline: 1px dashed rgba(243, 184, 65, 0.85);
        outline-offset: 2px;
      }
      .${OVERLAY_EDITING_CLASS} {
        outline: 2px solid rgba(243, 184, 65, 0.95);
        outline-offset: 2px;
        background: rgba(243, 184, 65, 0.05);
      }
    `}</style>
  );
}

/**
 * Swap the text node for a contentEditable span and wire up commit /
 * cancel. Exported for the RTL tests in `preview-inline-overlay.test.tsx`
 * so the click → editable transition can be simulated without a full
 * iframe harness.
 */
export function beginInlineEdit(args: {
  el: HTMLElement;
  pageIndex: number;
  sectionIndex: number;
  field: TextField | "cta.label" | "cta.href";
  editingRef: React.MutableRefObject<HTMLElement | null>;
  editingOriginalText: React.MutableRefObject<string>;
}) {
  const { el, pageIndex, sectionIndex, field } = args;

  // Already editing this element? Leave it alone.
  if (args.editingRef.current === el) return;
  // Only one editable at a time — commit any in-progress edit first.
  if (args.editingRef.current) {
    commitInlineEdit(args.editingRef.current, false);
  }

  const original =
    field === "cta.href"
      ? (el as HTMLAnchorElement).href ?? ""
      : el.textContent ?? "";
  args.editingRef.current = el;
  args.editingOriginalText.current = original;
  el.classList.add(OVERLAY_EDITING_CLASS);
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "true");
  el.dataset.instinctEditing = "1";
  el.dataset.instinctPageIndex = String(pageIndex);
  el.dataset.instinctSectionIndex = String(sectionIndex);
  el.dataset.instinctField = field;

  // For cta.href, the link's visible text is still the label — we stage
  // the href value in a data attribute and edit the text via a prompt
  // fallback. But per P2 scope, href is a future enhancement; today the
  // click swaps the anchor into label-edit mode and the href stays.
  if (field === "cta.href") {
    el.textContent = original;
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      commitInlineEdit(el, true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelInlineEdit(el);
    }
  };
  const onBlur = () => {
    // Delay one tick so Enter-key commit wins the race.
    setTimeout(() => {
      if (el.dataset.instinctEditing === "1") commitInlineEdit(el, true);
    }, 0);
  };

  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("blur", onBlur, { once: false });

  // Stash listeners on the element so commit/cancel can remove them.
  (el as unknown as { __instinctInlineCleanup?: () => void }).__instinctInlineCleanup =
    () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("blur", onBlur);
    };

  // Focus with caret at end of content.
  requestAnimationFrame(() => {
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* focus is best-effort */
    }
  });
}

function cleanupEditable(el: HTMLElement) {
  el.removeAttribute("contenteditable");
  el.removeAttribute("spellcheck");
  delete el.dataset.instinctEditing;
  el.classList.remove(OVERLAY_EDITING_CLASS);
  const cleanup = (el as unknown as { __instinctInlineCleanup?: () => void })
    .__instinctInlineCleanup;
  if (cleanup) cleanup();
}

function cancelInlineEdit(el: HTMLElement) {
  cleanupEditable(el);
  el.blur();
}

/**
 * Commit the current contentEditable value. Posts a text.edit / cta.edit
 * message to the parent if the value actually changed. Always cleans up
 * the editable state. `fire` controls whether we emit analytics — we
 * pass false for the implicit "clean up old edit before starting a new
 * one" path so we don't double-count.
 */
export function commitInlineEdit(el: HTMLElement, fire: boolean) {
  const pageIndex = Number(el.dataset.instinctPageIndex ?? "0");
  const sectionIndex = Number(el.dataset.instinctSectionIndex ?? "-1");
  const rawField = el.dataset.instinctField ?? "";
  const value = (el.textContent ?? "").replace(/\u00a0/g, " ").trim();

  cleanupEditable(el);

  if (!fire) return;
  if (!Number.isFinite(sectionIndex) || sectionIndex < 0) return;

  let message: InlineEditMessage | null = null;
  if (rawField === "cta.label" || rawField === "cta.href") {
    message = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex,
      sectionIndex,
      field: rawField === "cta.label" ? "label" : "href",
      value,
    };
  } else if (
    rawField === "heading" ||
    rawField === "body" ||
    rawField === "tagline" ||
    rawField === "quote" ||
    rawField === "attribution"
  ) {
    message = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex,
      sectionIndex,
      field: rawField,
      value,
    };
  }

  if (!message) return;

  try {
    window.parent.postMessage(message, window.location.origin);
  } catch {
    /* non-fatal — parent might not be listening */
  }
}

/**
 * SeoHeadInjector — mounts per-page SEO metadata into `document.head`
 * for the client-rendered preview surface.
 *
 * Why DOM-mutate instead of using Next.js `<head>`: the preview route is
 * a `"use client"` component; Next's metadata API is server-only and the
 * route mounts INSIDE an iframe where SSR metadata doesn't reach this
 * nested document's head. We own the surface, so we inject on mount and
 * clean up on unmount. Tags we own are tagged with
 * `data-instinct-seo="1"` so we never remove the page's pre-existing
 * head children.
 */
export function SeoHeadInjector({
  brief,
  pageIndex,
}: {
  brief: SiteBrief | null;
  pageIndex: number;
}) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!brief) return;
    const previewUrl =
      typeof window !== "undefined" ? window.location.origin : undefined;
    let tags: SeoMetaTag[];
    try {
      tags = buildSeoMetaTags({ brief, pageIndex, previewUrl });
    } catch {
      // Never let SEO injection crash the preview render.
      return;
    }
    const appended: Node[] = [];
    // Remove any previously injected Instinct SEO tags first so we don't
    // pile up duplicates on route changes (e.g., user paginates pages).
    document
      .querySelectorAll('[data-instinct-seo="1"]')
      .forEach((el) => el.parentElement?.removeChild(el));
    for (const descriptor of tags) {
      if (descriptor.tag === "title") {
        // <title> is a singleton; rewrite its text in-place so we don't
        // fight existing title elements.
        let titleEl = document.head.querySelector(
          'title[data-instinct-seo="1"]',
        ) as HTMLTitleElement | null;
        if (!titleEl) {
          titleEl = document.createElement("title");
          titleEl.setAttribute("data-instinct-seo", "1");
          document.head.appendChild(titleEl);
          appended.push(titleEl);
        }
        titleEl.text = descriptor.attrs.text ?? "";
        continue;
      }
      const el = document.createElement(descriptor.tag);
      el.setAttribute("data-instinct-seo", "1");
      for (const [k, v] of Object.entries(descriptor.attrs)) {
        el.setAttribute(k, v);
      }
      document.head.appendChild(el);
      appended.push(el);
    }
    return () => {
      for (const node of appended) {
        node.parentElement?.removeChild(node);
      }
    };
  }, [brief, pageIndex]);
  return null;
}
