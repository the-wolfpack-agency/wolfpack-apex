"use client";

/**
 * InspectorPanel — right-rail context-sensitive editor for the selected
 * section. Mirrors Framer / Webflow / v0: the center pane shows the
 * preview, the right pane shows the properties of whatever the designer
 * has selected.
 *
 * Field contract:
 *   - Heading / Body / CTA label / CTA href / Background image URL /
 *     Attribution — all plain text inputs. Present only when the section
 *     type supports that field (e.g. quote has body + attribution, but
 *     cards have items[]).
 *   - Every field-change calls `onFieldChange(fieldPath, value)` with a
 *     slash-delimited path like `heading`, `cta/label`, `items/0/title`.
 *     The StudioShell owns the brief and translates the path into a
 *     deep-set mutation so the preview iframe re-renders.
 *   - Field changes also dispatch `brief.push` postMessage to the
 *     preview iframe through the existing `encodeBriefPush` bridge —
 *     which is imported from src/lib/preview-postmessage.ts (the
 *     DO-NOT-TOUCH module). We never redefine that contract here.
 *
 * Analytics: every edit triggers `onAnalyticsFieldEdited(fieldPath)`
 * which the shell maps to `studio.inspector_field_edited`.
 *
 * A11y: each field gets a real <label htmlFor>. No <details> accordions.
 */

import type { BriefSection } from "@/lib/sites-schema";
import type { ChangeEvent } from "react";

export interface InspectorPanelProps {
  /** The selected section (null when no selection). */
  section: BriefSection | null;
  sectionIndex: number | null;
  /** Fires on every keystroke. The shell batches/debounces if needed. */
  onFieldChange: (fieldPath: string, value: string) => void;
  /** Analytics hook — fired alongside onFieldChange. */
  onAnalyticsFieldEdited?: (fieldPath: string, sectionId: string) => void;
  testIdPrefix?: string;
}

interface FieldSpec {
  path: string;
  label: string;
  /** Optional placeholder copy for the input. */
  placeholder?: string;
  /** textarea vs input. Default input. */
  multiline?: boolean;
}

/**
 * Which fields to surface per section type. Pure — easy to unit-test.
 * We keep this deliberately narrow: the inspector is for the "90% case"
 * edit flow. Complex collection editors (items[]) live in the full
 * BriefForm under the Sections tab's advanced drawer.
 */
export function fieldSpecsForSection(section: BriefSection): FieldSpec[] {
  const base: FieldSpec[] = [
    { path: "heading", label: "Heading", placeholder: "Section heading" },
    {
      path: "body",
      label: "Body",
      multiline: true,
      placeholder: "Section body copy",
    },
  ];
  // All section types we care about accept an optional CTA — show the
  // pair even when absent; edits land through onFieldChange and the
  // shell creates the cta object on first write.
  base.push(
    { path: "cta/label", label: "CTA label", placeholder: "Learn more" },
    { path: "cta/href", label: "CTA href", placeholder: "https://example.com" },
  );
  if (section.type === "hero" || section.type === "banner") {
    base.push({
      path: "backgroundImage",
      label: "Background image URL",
      placeholder: "https://…",
    });
  }
  if (section.type === "quote") {
    base.push({
      path: "attribution",
      label: "Attribution",
      placeholder: "— Author, Title",
    });
  }
  return base;
}

/**
 * Reads the current value for a field path on a section. Pure, exported
 * so tests can pin the read semantics (slash paths, missing cta object,
 * etc.) without mounting the component.
 */
export function readSectionField(
  section: BriefSection,
  path: string,
): string {
  const parts = path.split("/");
  let cur: unknown = section;
  for (const p of parts) {
    if (cur == null) return "";
    if (typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur == null) return "";
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return "";
}

export default function InspectorPanel({
  section,
  sectionIndex,
  onFieldChange,
  onAnalyticsFieldEdited,
  testIdPrefix = "studio-inspector",
}: InspectorPanelProps) {
  if (!section || sectionIndex === null) {
    return (
      <div
        data-testid={`${testIdPrefix}-empty`}
        style={{
          padding: 16,
          fontSize: 12,
          color: "var(--wp-text-dim, #8a8a8a)",
          lineHeight: 1.5,
        }}
      >
        <h3
          style={{
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--wp-text-dim, #8a8a8a)",
            margin: "0 0 8px",
          }}
        >
          Inspector
        </h3>
        <p style={{ margin: 0 }}>
          Select a section in the outline or click directly in the preview
          to edit its fields here.
        </p>
      </div>
    );
  }

  const specs = fieldSpecsForSection(section);

  function handleChange(
    path: string,
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const value = e.target.value;
    onFieldChange(path, value);
    onAnalyticsFieldEdited?.(path, `${sectionIndex}:${section?.type ?? ""}`);
  }

  return (
    <div
      data-testid={`${testIdPrefix}`}
      data-section-index={sectionIndex}
      data-section-type={section.type}
      style={{ padding: 16 }}
    >
      <header style={{ marginBottom: 12 }}>
        <h3
          style={{
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--wp-text-dim, #8a8a8a)",
            margin: 0,
          }}
        >
          Inspector
        </h3>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--wp-text, #e6e6e6)",
            marginTop: 4,
          }}
        >
          {section.type} · section {sectionIndex + 1}
        </div>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {specs.map((spec) => {
          const inputId = `${testIdPrefix}-field-${spec.path.replace(/\//g, "-")}`;
          const value = readSectionField(section, spec.path);
          return (
            <div key={spec.path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label
                htmlFor={inputId}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--wp-text-dim, #8a8a8a)",
                }}
              >
                {spec.label}
              </label>
              {spec.multiline ? (
                <textarea
                  id={inputId}
                  data-testid={inputId}
                  data-field-path={spec.path}
                  rows={3}
                  value={value}
                  placeholder={spec.placeholder}
                  onChange={(e) => handleChange(spec.path, e)}
                  style={fieldStyle}
                />
              ) : (
                <input
                  id={inputId}
                  data-testid={inputId}
                  data-field-path={spec.path}
                  type="text"
                  value={value}
                  placeholder={spec.placeholder}
                  onChange={(e) => handleChange(spec.path, e)}
                  style={fieldStyle}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const fieldStyle = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
  background: "var(--wp-card, rgba(255,255,255,0.04))",
  color: "var(--wp-text, #e6e6e6)",
  fontSize: 12,
  fontFamily: "inherit",
} as const;
