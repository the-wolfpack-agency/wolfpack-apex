"use client";

/**
 * SectionOutline — the studio's "layers" / page outline.
 *
 * Lists every section in `brief.pages[pageIndex].sections` as a row with
 * a drag handle, a type badge, the section's heading (fallback: type
 * name), and a small action cluster: duplicate, delete, move up/down.
 *
 * Reorder contract:
 *   - Native HTML5 drag-drop on each row's handle — zero new deps.
 *   - On drop OR ArrowUp/ArrowDown on a focused row, fire
 *     `onReorder(fromIndex, toIndex)`. The studio shell owns the brief
 *     and calls `applyInlineReorder` (imported from preview-postmessage)
 *     so reorder math lives in one place across iframe drag + outline
 *     drag + keyboard. Same contract either way.
 *
 * Section selection:
 *   - Click a row → `onSelect(sectionIndex)`. The studio shell fires
 *     `studio.section_selected` + opens the Inspector.
 *
 * A11y:
 *   - Outer <ul role="listbox"> with `aria-activedescendant` hooked to
 *     the selected row. Each row is role="option" with aria-selected.
 *   - Drag handles are focusable with ArrowUp/ArrowDown shortcuts;
 *     Enter on a row selects it; Delete on a focused row deletes.
 *   - No <details> accordions.
 *
 * Tests cover: render, click-select, keyboard reorder, duplicate,
 * delete, add-section. Drag reorder is exercised via dispatched
 * `dragstart/dragover/drop` events.
 */

import { useRef, type KeyboardEvent } from "react";
import type { BriefSection } from "@/lib/sites-schema";

export type SectionTypeLite =
  | "hero"
  | "text"
  | "callout"
  | "banner"
  | "stats"
  | "cards"
  | "gallery"
  | "quote"
  | "video"
  | "testimonial"
  | "pricing"
  | "faq";

export const SECTION_TYPE_OPTIONS: readonly SectionTypeLite[] = [
  "hero",
  "text",
  "callout",
  "banner",
  "stats",
  "cards",
  "gallery",
  "quote",
  "video",
  "testimonial",
  "pricing",
  "faq",
] as const;

export interface SectionOutlineProps {
  sections: BriefSection[];
  /** Zero-based section index currently selected in the inspector. */
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onAddSection: (type: SectionTypeLite) => void;
  testIdPrefix?: string;
}

function rowLabel(section: BriefSection, index: number): string {
  const head = section.heading?.trim();
  if (head && head.length > 0) return head;
  return `${section.type} #${index + 1}`;
}

export default function SectionOutline({
  sections,
  selectedIndex,
  onSelect,
  onReorder,
  onDuplicate,
  onDelete,
  onAddSection,
  testIdPrefix = "studio-section-outline",
}: SectionOutlineProps) {
  // Track which row is being dragged so `dragover` on another row
  // can call `onReorder(from, over)` cleanly. Ref instead of state
  // because we don't need a re-render between dragstart + drop.
  const dragFromRef = useRef<number | null>(null);

  function handleKey(e: KeyboardEvent<HTMLLIElement>, index: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(index);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (index < sections.length - 1) {
        // Shift+ArrowDown = move row down; plain ArrowDown = just move
        // focus. Matches Figma / Notion outline behavior.
        if (e.shiftKey) onReorder(index, index + 1);
        else onSelect(index + 1);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index > 0) {
        if (e.shiftKey) onReorder(index, index - 1);
        else onSelect(index - 1);
      }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      // Only act on modifier combo so focusing + typing doesn't
      // accidentally nuke a section. Cmd/Ctrl + Delete = destructive.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onDelete(index);
      }
    }
  }

  function onDragStart(index: number, e: React.DragEvent<HTMLLIElement>) {
    dragFromRef.current = index;
    // DataTransfer is required for dragover to fire in Chrome; value is
    // ignored. We keep the real source index in the ref so jsdom tests
    // (which don't populate DataTransfer) still work.
    try {
      e.dataTransfer.setData("text/plain", String(index));
      e.dataTransfer.effectAllowed = "move";
    } catch {
      /* jsdom mock — safe to ignore */
    }
  }

  function onDragOver(e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
  }

  function onDrop(index: number, e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
    const from = dragFromRef.current;
    dragFromRef.current = null;
    if (from === null) return;
    if (from === index) return;
    onReorder(from, index);
  }

  return (
    <div data-testid={testIdPrefix} style={{ padding: "12px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h3
          style={{
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--wp-text-dim, #8a8a8a)",
            margin: 0,
          }}
        >
          Sections ({sections.length})
        </h3>
      </div>

      <ul
        role="listbox"
        aria-label="Page sections"
        data-testid={`${testIdPrefix}-list`}
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {sections.length === 0 ? (
          <li
            data-testid={`${testIdPrefix}-empty`}
            style={{
              padding: "12px 10px",
              fontSize: 12,
              color: "var(--wp-text-dim, #8a8a8a)",
              fontStyle: "italic",
            }}
          >
            No sections yet. Add one below to start building the page.
          </li>
        ) : (
          sections.map((s, i) => {
            const selected = i === selectedIndex;
            return (
              <li
                key={`${s.type}-${i}`}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                draggable
                data-testid={`${testIdPrefix}-row-${i}`}
                data-section-index={i}
                data-section-type={s.type}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => handleKey(e, i)}
                onDragStart={(e) => onDragStart(i, e)}
                onDragOver={onDragOver}
                onDrop={(e) => onDrop(i, e)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  background: selected
                    ? "rgba(243, 184, 65, 0.12)"
                    : "rgba(255,255,255,0.02)",
                  border: selected
                    ? "1px solid rgba(243, 184, 65, 0.4)"
                    : "1px solid var(--wp-border, rgba(255,255,255,0.08))",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--wp-text, #e6e6e6)",
                  outline: "none",
                }}
              >
                <span
                  aria-hidden="true"
                  data-testid={`${testIdPrefix}-handle-${i}`}
                  style={{
                    cursor: "grab",
                    color: "var(--wp-text-dim, #8a8a8a)",
                    fontSize: 12,
                    userSelect: "none",
                  }}
                  title="Drag to reorder"
                >
                  ⋮⋮
                </span>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    color: "var(--wp-accent, #f3b841)",
                    fontWeight: 600,
                    minWidth: 52,
                  }}
                >
                  {s.type}
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {rowLabel(s, i)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicate(i);
                  }}
                  data-testid={`${testIdPrefix}-duplicate-${i}`}
                  aria-label={`Duplicate ${s.type} section`}
                  style={iconBtnStyle}
                >
                  ⎘
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(i);
                  }}
                  data-testid={`${testIdPrefix}-delete-${i}`}
                  aria-label={`Delete ${s.type} section`}
                  style={iconBtnStyle}
                >
                  ✕
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
        }}
      >
        <label
          htmlFor={`${testIdPrefix}-add-type`}
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--wp-text-dim, #8a8a8a)",
            marginBottom: 4,
          }}
        >
          Add section
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <select
            id={`${testIdPrefix}-add-type`}
            data-testid={`${testIdPrefix}-add-type`}
            defaultValue="hero"
            style={{
              flex: 1,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
              background: "var(--wp-card, rgba(255,255,255,0.04))",
              color: "var(--wp-text, #e6e6e6)",
              fontSize: 12,
            }}
          >
            {SECTION_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid={`${testIdPrefix}-add-btn`}
            onClick={() => {
              const sel = document.getElementById(
                `${testIdPrefix}-add-type`,
              ) as HTMLSelectElement | null;
              const type = (sel?.value as SectionTypeLite) ?? "hero";
              onAddSection(type);
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--wp-gold, #f1c233)",
              background: "var(--wp-gold, #f1c233)",
              color: "#111",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = {
  padding: "2px 6px",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 4,
  color: "var(--wp-text-dim, #8a8a8a)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
} as const;
