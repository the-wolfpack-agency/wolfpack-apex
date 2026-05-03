"use client";

/**
 * DirectEditOverlay — Path C Phase 4 · Stream U2.
 *
 * User-facing click-to-edit overlay for the Instinct site preview iframe.
 * Mounted ONLY when the preview URL carries `?mode=edit` — public share
 * links and the view-only detail iframe never get it. When mounted, the
 * overlay:
 *
 *   1. Walks the rendered brief DOM (`[data-testid="render-brief"]`) and
 *      attaches hover + click handlers to editable elements: headings,
 *      paragraphs, CTAs, and section containers themselves.
 *   2. On click, renders a floating toolbar anchored to the clicked
 *      element. Three flavors:
 *        - Text  → inline contentEditable, Enter/blur commits, Escape
 *          discards. Sanitized via `textContent` — no HTML ever leaves
 *          the iframe. Dispatches `text.edit` postMessage to the parent.
 *        - CTA   → Label / Href inputs + Save / Cancel. Dispatches
 *          `cta.edit` (label and href are two separate messages — the
 *          parent coalesces them into the same brief mutation).
 *        - Section → ↑ ↓ Duplicate Delete button row. Dispatches
 *          `section.reorder` / `section.duplicate` / `section.delete`.
 *   3. Fires six typed analytics events — see `InstinctEventType`.
 *
 * Security:
 *   - Only `window.parent` on the same origin is trusted (see
 *     `parentIsSameOrigin` helper). If we are not in an iframe under
 *     the editor shell, the overlay no-ops.
 *   - contentEditable output is always read via `textContent`, never
 *     `innerHTML`. HTML pasted into the editable node is coerced to
 *     plain text at commit time via the guard function below.
 *   - Nested clicks bubble upward through event.stopPropagation on the
 *     specific target so clicking a CTA inside a hero section edits the
 *     CTA, NOT the whole section.
 *
 * Analytics:
 *   - direct_edit.enabled / .disabled fire from the surrounding toggle
 *     component (`DirectEditToggle`), not from the overlay itself — the
 *     overlay may mount/unmount multiple times per "enabled" session.
 *   - direct_edit.element_clicked fires on every click that opens a
 *     toolbar, with `element_type` ∈ {"heading", "body", "cta",
 *     "section"}.
 *   - direct_edit.text_committed / .cta_committed / .section_reordered_
 *     via_canvas fire from the commit handlers.
 *
 * This component is imported dynamically with `ssr: false` from the
 * preview page — it heavily depends on `window` and `document`, both of
 * which are undefined during SSR.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INSTINCT_EDIT_ORIGIN,
  type InlineEditMessage,
  type TextField,
} from "@/lib/preview-postmessage";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import { htmlToText } from "@/lib/html-sanitize";

/** Event types we track from this overlay. Kept here as constants so a
 *  test importing the component can assert the string literals. */
export const DIRECT_EDIT_EVENTS = {
  ENABLED: "direct_edit.enabled",
  DISABLED: "direct_edit.disabled",
  ELEMENT_CLICKED: "direct_edit.element_clicked",
  TEXT_COMMITTED: "direct_edit.text_committed",
  CTA_COMMITTED: "direct_edit.cta_committed",
  SECTION_REORDERED_VIA_CANVAS: "direct_edit.section_reordered_via_canvas",
} as const;

/**
 * Same-origin parent check copied from preview/page.tsx so we keep the
 * invariant even if U1's flow changes.
 */
function parentIsSameOrigin(): boolean {
  if (typeof window === "undefined") return false;
  if (window.parent === window) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Post a typed message to the parent edit-page window. Swallows errors —
 * a missing / cross-origin parent is silently non-actionable, not fatal.
 */
function postToParent(message: InlineEditMessage): void {
  if (typeof window === "undefined") return;
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch {
    /* non-fatal */
  }
}

/**
 * Fire-and-forget analytics event. Uses the existing `/api/analytics`
 * route so every direct-edit interaction lands in `instinct_events` and
 * the triple-write Qdrant/Neo4j ingest.
 */
function emitAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean> = {},
): void {
  if (typeof window === "undefined") return;
  try {
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { ...authHeaders(), ...jsonHeaders() },
      body: JSON.stringify({ event, metadata }),
    }).catch(() => {});
  } catch {
    /* non-fatal */
  }
}

/**
 * Strip HTML from a text payload so pasted-in rich text never reaches
 * the brief. Browsers will happily paste formatted HTML into a
 * contentEditable node; `textContent` on a DOM tree throws away tags
 * but keeps visible text, which is exactly what we want. For safety we
 * also collapse runs of whitespace and trim.
 *
 * Exported for unit tests that need to pin the sanitization contract.
 */
export function sanitizeEditableText(raw: string): string {
  // Parser-based HTML→text via @/lib/html-sanitize. The previous regex
  // strip + `textContent` chain was flagged by CodeQL for
  // js/incomplete-multi-character-sanitization, js/bad-tag-filter, and
  // js/xss-through-dom on the temporary `innerHTML` assignment.
  return htmlToText(raw).replace(/\s+/g, " ").trim();
}

/* --------------------------- Editable selectors -------------------------- */

type ElementKind = "heading" | "body" | "cta" | "section";

interface EditableEntry {
  selector: string;
  kind: ElementKind;
  field: TextField | "cta.label";
}

/**
 * Mirrors the EDITABLE_SELECTORS map from the existing inline-edit
 * overlay, but adds the element KIND so the toolbar can render the
 * correct flavor (heading vs body vs CTA vs section).
 *
 * For CTAs we target the `data-testid` hooks already baked into the
 * hero/callout/banner renderers. For section containers we attach
 * handlers to the `[data-section-type]` root itself.
 */
const EDITABLE_ENTRIES_BY_SECTION: Record<string, EditableEntry[]> = {
  hero: [
    { selector: "h1", kind: "heading", field: "heading" },
    { selector: "p", kind: "body", field: "body" },
    { selector: '[data-testid="hero-cta"]', kind: "cta", field: "cta.label" },
  ],
  text: [
    { selector: "h2", kind: "heading", field: "heading" },
    { selector: "p", kind: "body", field: "body" },
  ],
  quote: [
    { selector: "blockquote > p", kind: "body", field: "body" },
    { selector: "footer", kind: "body", field: "attribution" },
  ],
  callout: [
    { selector: "h3", kind: "heading", field: "heading" },
    { selector: "aside > p", kind: "body", field: "body" },
    {
      selector: '[data-testid="callout-cta"]',
      kind: "cta",
      field: "cta.label",
    },
  ],
  banner: [
    { selector: "h2", kind: "heading", field: "heading" },
    { selector: "p", kind: "body", field: "body" },
    { selector: '[data-testid="banner-cta"]', kind: "cta", field: "cta.label" },
  ],
};

/* ----------------------------- Selection state ---------------------------- */

interface SelectionState {
  kind: ElementKind;
  // Section index is always required (every element lives inside a section).
  sectionIndex: number;
  // Text/body field — only present for text edits.
  field?: TextField;
  // For CTAs we also track the current label/href so the input is pre-filled.
  ctaLabel?: string;
  ctaHref?: string;
  // Anchor for the floating toolbar. Screen-space viewport rect.
  anchorRect: { top: number; left: number; width: number; height: number };
  // The DOM element being edited (only for text kind — the toolbar
  // flips it to contentEditable). Not held for section/CTA paths.
  target?: HTMLElement | null;
}

export interface DirectEditOverlayProps {
  pageIndex: number;
  /** Total number of sections on the current page — used to clamp
   *  reorder arrows at the list boundaries. */
  sectionCount: number;
  /** Optional test-only hook so tests can observe analytics without
   *  hitting the real `/api/analytics` route. */
  onAnalyticsEvent?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

/* ------------------------------ Implementation ---------------------------- */

const OVERLAY_HOVER_CLASS = "instinct-direct-edit-hover";
const OVERLAY_ACTIVE_CLASS = "instinct-direct-edit-active";

export function DirectEditOverlay({
  pageIndex,
  sectionCount,
  onAnalyticsEvent,
}: DirectEditOverlayProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const editingElRef = useRef<HTMLElement | null>(null);

  // Emit helper — delegates to either the test hook or the real route.
  const emit = useCallback(
    (event: string, metadata: Record<string, string | number | boolean> = {}) => {
      if (onAnalyticsEvent) onAnalyticsEvent(event, metadata);
      else emitAnalytics(event, metadata);
    },
    [onAnalyticsEvent],
  );

  /* ------------------------ Commit helpers (stable refs) ------------------ */

  const commitTextEdit = useCallback(
    (el: HTMLElement, field: TextField, sectionIndex: number) => {
      const raw = el.textContent ?? "";
      const value = sanitizeEditableText(raw);
      // Write the sanitized value BACK into the DOM so what the user
      // sees is exactly what we ship to the brief.
      el.textContent = value;
      el.removeAttribute("contenteditable");
      el.classList.remove(OVERLAY_ACTIVE_CLASS);
      delete el.dataset.instinctDirectEditing;
      editingElRef.current = null;

      const msg: InlineEditMessage = {
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex,
        sectionIndex,
        field,
        value,
      };
      postToParent(msg);
      emit(DIRECT_EDIT_EVENTS.TEXT_COMMITTED, {
        section_id: sectionIndex,
        field,
      });
    },
    [pageIndex, emit],
  );

  const discardTextEdit = useCallback((el: HTMLElement, originalText: string) => {
    el.textContent = originalText;
    el.removeAttribute("contenteditable");
    el.classList.remove(OVERLAY_ACTIVE_CLASS);
    delete el.dataset.instinctDirectEditing;
    editingElRef.current = null;
  }, []);

  /* -------------------------- Hover + click wiring ------------------------ */

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!parentIsSameOrigin()) return;

    const root = document.querySelector('[data-testid="render-brief"]');
    if (!root) return;

    const sectionNodes = Array.from(
      root.querySelectorAll<HTMLElement>("[data-section-type]"),
    );
    const cleanups: Array<() => void> = [];

    // Section-level handlers first so inner-element handlers can
    // stopPropagation cleanly.
    sectionNodes.forEach((sectionEl, sectionIndex) => {
      const sectionType = sectionEl.dataset.sectionType ?? "";
      sectionEl.dataset.instinctDirectSectionIndex = String(sectionIndex);

      const onEnter = () => sectionEl.classList.add(OVERLAY_HOVER_CLASS);
      const onLeave = () => sectionEl.classList.remove(OVERLAY_HOVER_CLASS);
      const onClick = (ev: MouseEvent) => {
        // Already handled by a child? bail. Children stopPropagation on
        // their own clicks so this only fires for "click the empty
        // margin of the section".
        const rect = sectionEl.getBoundingClientRect();
        setSelection({
          kind: "section",
          sectionIndex,
          anchorRect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
        });
        ev.stopPropagation();
        emit(DIRECT_EDIT_EVENTS.ELEMENT_CLICKED, { element_type: "section" });
      };

      sectionEl.addEventListener("mouseenter", onEnter);
      sectionEl.addEventListener("mouseleave", onLeave);
      sectionEl.addEventListener("click", onClick);
      cleanups.push(() => {
        sectionEl.removeEventListener("mouseenter", onEnter);
        sectionEl.removeEventListener("mouseleave", onLeave);
        sectionEl.removeEventListener("click", onClick);
        sectionEl.classList.remove(OVERLAY_HOVER_CLASS);
        delete sectionEl.dataset.instinctDirectSectionIndex;
      });

      // Inner editable targets — headings / body / CTAs.
      const entries = EDITABLE_ENTRIES_BY_SECTION[sectionType] ?? [];
      for (const entry of entries) {
        const target = sectionEl.querySelector<HTMLElement>(entry.selector);
        if (!target) continue;
        target.classList.add("instinct-direct-edit-target");

        const onTargetEnter = () => target.classList.add(OVERLAY_HOVER_CLASS);
        const onTargetLeave = () => target.classList.remove(OVERLAY_HOVER_CLASS);
        const onTargetClick = (ev: MouseEvent) => {
          // Nested click: CTA inside a hero = edit the CTA, not the hero.
          ev.stopPropagation();
          // Anchor links inside CTAs must not navigate while editing.
          if (entry.kind === "cta") ev.preventDefault();

          const rect = target.getBoundingClientRect();
          if (entry.kind === "cta") {
            setSelection({
              kind: "cta",
              sectionIndex,
              ctaLabel: target.textContent ?? "",
              ctaHref:
                (target as HTMLAnchorElement).href ??
                target.getAttribute("href") ??
                "",
              anchorRect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              },
            });
            emit(DIRECT_EDIT_EVENTS.ELEMENT_CLICKED, { element_type: "cta" });
          } else {
            // Text: flip to contentEditable in-place. Toolbar only renders
            // commit/cancel affordances + Escape-to-discard hint.
            if (editingElRef.current && editingElRef.current !== target) {
              // Commit any in-progress edit so we never have two open.
              const prior = editingElRef.current;
              if (prior.dataset.instinctDirectEditing === "1") {
                const priorField = (prior.dataset.instinctDirectField ??
                  "heading") as TextField;
                const priorSection = Number(
                  prior.dataset.instinctDirectSectionIdx ?? "-1",
                );
                if (priorSection >= 0) {
                  commitTextEdit(prior, priorField, priorSection);
                }
              }
            }
            target.dataset.instinctDirectEditing = "1";
            target.dataset.instinctDirectField = entry.field as string;
            target.dataset.instinctDirectSectionIdx = String(sectionIndex);
            target.setAttribute("contenteditable", "true");
            target.setAttribute("spellcheck", "true");
            target.classList.add(OVERLAY_ACTIVE_CLASS);
            editingElRef.current = target;
            const originalText = target.textContent ?? "";

            setSelection({
              kind: entry.kind,
              sectionIndex,
              field: entry.field as TextField,
              target,
              anchorRect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              },
            });

            // Keyboard: Enter commits for headings (single-line), Escape
            // discards everywhere. For body paragraphs Shift+Enter keeps
            // a newline; Enter alone still commits so mobile keyboards
            // behave.
            const onKey = (kev: KeyboardEvent) => {
              if (kev.key === "Escape") {
                kev.preventDefault();
                discardTextEdit(target, originalText);
                setSelection(null);
                target.removeEventListener("keydown", onKey);
                target.removeEventListener("blur", onBlur);
              } else if (kev.key === "Enter" && !kev.shiftKey) {
                kev.preventDefault();
                commitTextEdit(target, entry.field as TextField, sectionIndex);
                setSelection(null);
                target.removeEventListener("keydown", onKey);
                target.removeEventListener("blur", onBlur);
              }
            };
            const onBlur = () => {
              // One-tick delay so Enter-commit races blur deterministically.
              setTimeout(() => {
                if (target.dataset.instinctDirectEditing === "1") {
                  commitTextEdit(
                    target,
                    entry.field as TextField,
                    sectionIndex,
                  );
                  setSelection(null);
                }
                target.removeEventListener("keydown", onKey);
                target.removeEventListener("blur", onBlur);
              }, 0);
            };
            target.addEventListener("keydown", onKey);
            target.addEventListener("blur", onBlur);

            requestAnimationFrame(() => {
              try {
                target.focus();
                const range = document.createRange();
                range.selectNodeContents(target);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch {
                /* best-effort */
              }
            });

            emit(DIRECT_EDIT_EVENTS.ELEMENT_CLICKED, {
              element_type: entry.kind,
            });
          }
        };

        target.addEventListener("mouseenter", onTargetEnter);
        target.addEventListener("mouseleave", onTargetLeave);
        target.addEventListener("click", onTargetClick);
        cleanups.push(() => {
          target.removeEventListener("mouseenter", onTargetEnter);
          target.removeEventListener("mouseleave", onTargetLeave);
          target.removeEventListener("click", onTargetClick);
          target.classList.remove(OVERLAY_HOVER_CLASS);
          target.classList.remove("instinct-direct-edit-target");
        });
      }
    });

    // Click-outside closes the toolbar (but doesn't discard an in-flight
    // text edit — that's handled by blur above).
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target as Element | null;
      if (!t) return;
      if (t.closest('[data-testid="direct-edit-toolbar"]')) return;
      if (t.closest("[data-section-type]")) return;
      setSelection(null);
    };
    document.addEventListener("click", onDocClick);
    cleanups.push(() => document.removeEventListener("click", onDocClick));

    return () => cleanups.forEach((fn) => fn());
  }, [pageIndex, commitTextEdit, discardTextEdit, emit]);

  /* ------------------------------ Toolbar UI ------------------------------ */

  if (!selection) {
    return (
      <style data-testid="direct-edit-overlay-style">{`
        .instinct-direct-edit-target { cursor: text; }
        .${OVERLAY_HOVER_CLASS} {
          outline: 2px dashed rgba(80, 140, 220, 0.75);
          outline-offset: 3px;
        }
        .${OVERLAY_ACTIVE_CLASS} {
          outline: 2px solid rgba(80, 140, 220, 0.95);
          outline-offset: 3px;
          background: rgba(80, 140, 220, 0.06);
        }
      `}</style>
    );
  }

  const anchorTop = selection.anchorRect.top - 44;
  const anchorLeft = selection.anchorRect.left;

  const handleReorder = (direction: "up" | "down") => {
    const from = selection.sectionIndex;
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= sectionCount || to === from) return;
    const msg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "section.reorder",
      pageIndex,
      fromIndex: from,
      toIndex: to,
    };
    postToParent(msg);
    emit(DIRECT_EDIT_EVENTS.SECTION_REORDERED_VIA_CANVAS, {
      from_idx: from,
      to_idx: to,
    });
    setSelection(null);
  };

  const handleDuplicate = () => {
    const msg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "section.duplicate",
      pageIndex,
      sectionIndex: selection.sectionIndex,
    };
    postToParent(msg);
    setSelection(null);
  };

  const handleDelete = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete this section? This can be undone via version history.")
    ) {
      return;
    }
    const msg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "section.delete",
      pageIndex,
      sectionIndex: selection.sectionIndex,
    };
    postToParent(msg);
    setSelection(null);
  };

  const handleCtaSave = (label: string, href: string) => {
    const labelMsg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex,
      sectionIndex: selection.sectionIndex,
      field: "label",
      value: sanitizeEditableText(label),
    };
    postToParent(labelMsg);
    const hrefMsg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex,
      sectionIndex: selection.sectionIndex,
      field: "href",
      value: sanitizeEditableText(href),
    };
    postToParent(hrefMsg);
    emit(DIRECT_EDIT_EVENTS.CTA_COMMITTED, {
      section_id: selection.sectionIndex,
    });
    setSelection(null);
  };

  const handleCtaDelete = () => {
    // Delete a CTA by blanking both fields — the edit page treats empty
    // CTA label + href as "no CTA" in its render logic.
    const labelMsg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex,
      sectionIndex: selection.sectionIndex,
      field: "label",
      value: "",
    };
    postToParent(labelMsg);
    emit(DIRECT_EDIT_EVENTS.CTA_COMMITTED, {
      section_id: selection.sectionIndex,
    });
    setSelection(null);
  };

  return (
    <>
      <style data-testid="direct-edit-overlay-style">{`
        .instinct-direct-edit-target { cursor: text; }
        .${OVERLAY_HOVER_CLASS} {
          outline: 2px dashed rgba(80, 140, 220, 0.75);
          outline-offset: 3px;
        }
        .${OVERLAY_ACTIVE_CLASS} {
          outline: 2px solid rgba(80, 140, 220, 0.95);
          outline-offset: 3px;
          background: rgba(80, 140, 220, 0.06);
        }
      `}</style>
      <div
        data-testid="direct-edit-toolbar"
        data-kind={selection.kind}
        role="toolbar"
        aria-label="Direct-edit controls"
        style={{
          position: "fixed",
          top: Math.max(8, anchorTop),
          left: Math.max(8, anchorLeft),
          zIndex: 9999,
          background: "rgba(15, 17, 21, 0.95)",
          color: "white",
          padding: "6px 10px",
          borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          display: "flex",
          gap: 6,
          alignItems: "center",
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {selection.kind === "section" && (
          <SectionToolbar
            sectionIndex={selection.sectionIndex}
            sectionCount={sectionCount}
            onReorder={handleReorder}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onClose={() => setSelection(null)}
          />
        )}
        {selection.kind === "cta" && (
          <CtaToolbar
            initialLabel={selection.ctaLabel ?? ""}
            initialHref={selection.ctaHref ?? ""}
            onSave={handleCtaSave}
            onDelete={handleCtaDelete}
            onCancel={() => setSelection(null)}
          />
        )}
        {(selection.kind === "heading" || selection.kind === "body") && (
          <span data-testid="direct-edit-text-hint" style={{ opacity: 0.8 }}>
            Editing · Enter to save · Esc to discard
          </span>
        )}
      </div>
    </>
  );
}

/* ------------------------- Section action toolbar ------------------------- */

function SectionToolbar({
  sectionIndex,
  sectionCount,
  onReorder,
  onDuplicate,
  onDelete,
  onClose,
}: {
  sectionIndex: number;
  sectionCount: number;
  onReorder: (direction: "up" | "down") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const canUp = sectionIndex > 0;
  const canDown = sectionIndex < sectionCount - 1;
  return (
    <>
      <button
        type="button"
        data-testid="direct-edit-section-up"
        aria-label="Move section up"
        disabled={!canUp}
        onClick={() => onReorder("up")}
        style={toolbarBtnStyle(!canUp)}
      >
        {"\u2191"}
      </button>
      <button
        type="button"
        data-testid="direct-edit-section-down"
        aria-label="Move section down"
        disabled={!canDown}
        onClick={() => onReorder("down")}
        style={toolbarBtnStyle(!canDown)}
      >
        {"\u2193"}
      </button>
      <button
        type="button"
        data-testid="direct-edit-section-duplicate"
        aria-label="Duplicate section"
        onClick={onDuplicate}
        style={toolbarBtnStyle(false)}
      >
        Duplicate
      </button>
      <button
        type="button"
        data-testid="direct-edit-section-delete"
        aria-label="Delete section"
        onClick={onDelete}
        style={{ ...toolbarBtnStyle(false), color: "#ff9c9c" }}
      >
        Delete
      </button>
      <button
        type="button"
        data-testid="direct-edit-toolbar-close"
        aria-label="Close toolbar"
        onClick={onClose}
        style={toolbarBtnStyle(false)}
      >
        {"\u2715"}
      </button>
    </>
  );
}

/* ------------------------------ CTA toolbar ------------------------------ */

function CtaToolbar({
  initialLabel,
  initialHref,
  onSave,
  onDelete,
  onCancel,
}: {
  initialLabel: string;
  initialHref: string;
  onSave: (label: string, href: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [href, setHref] = useState(initialHref);
  return (
    <>
      <input
        data-testid="direct-edit-cta-label"
        aria-label="CTA label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(label, href);
          if (e.key === "Escape") onCancel();
        }}
        style={inputStyle}
        placeholder="Label"
      />
      <input
        data-testid="direct-edit-cta-href"
        aria-label="CTA href"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(label, href);
          if (e.key === "Escape") onCancel();
        }}
        style={inputStyle}
        placeholder="/destination"
      />
      <button
        type="button"
        data-testid="direct-edit-cta-save"
        onClick={() => onSave(label, href)}
        style={toolbarBtnStyle(false)}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="direct-edit-cta-delete"
        onClick={onDelete}
        style={{ ...toolbarBtnStyle(false), color: "#ff9c9c" }}
      >
        Remove
      </button>
      <button
        type="button"
        data-testid="direct-edit-cta-cancel"
        onClick={onCancel}
        style={toolbarBtnStyle(false)}
      >
        Cancel
      </button>
    </>
  );
}

/* -------------------------------- Styles --------------------------------- */

function toolbarBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: "rgba(255,255,255,0.06)",
    color: "white",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 4,
    padding: "4px 8px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    fontSize: 12,
    fontFamily: "inherit",
  };
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 12,
  width: 140,
  fontFamily: "inherit",
};

export default DirectEditOverlay;
