"use client";

/**
 * ExtractedFieldsTable — pure presentational table of extracted
 * fields, sorted by confidence desc. Renders an empty-state row when
 * the extractor returned nothing (e.g. PII pre-scan blocked, or the
 * vendor returned no fields for this document type).
 */

import { type ExtractedField } from "@/lib/document-recognition/types";

interface Props {
  fields: ExtractedField[];
}

/** Convert "WagesTipsAndOtherCompensation" or "wages_tips_compensation"
 *  into a Title Cased phrase. Conservative — handles camelCase,
 *  PascalCase, snake_case, kebab-case, and dotted names. */
export function humanizeFieldName(raw: string): string {
  if (!raw) return raw;
  const withSpaces = raw
    /* split camelCase / PascalCase boundaries */
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    /* split snake_case, kebab-case, dots */
    .replace(/[_\-.]+/g, " ")
    .trim();
  return withSpaces
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function pct(confidence: number): string {
  const c = Math.max(0, Math.min(1, confidence));
  return `${Math.round(c * 100)}%`;
}

export function ExtractedFieldsTable({ fields }: Props) {
  if (!fields || fields.length === 0) {
    return (
      <div
        data-testid="extracted-fields-empty"
        className="rounded-lg px-4 py-6 text-sm text-center"
        style={{
          background: "var(--wp-dark-surface, #151515)",
          border: "1px dashed var(--wp-dark-border, #333)",
          color: "var(--wp-text-dim, #aaa)",
        }}
      >
        No fields extracted. The classifier may have matched a generic
        type, or the document type does not have a structured
        extractor.
      </div>
    );
  }

  /* Sort descending by confidence WITHOUT mutating the prop array.
     `[...arr].sort()` keeps the input pure-functional. */
  const sorted = [...fields].sort((a, b) => b.confidence - a.confidence);

  return (
    <div
      data-testid="extracted-fields-table"
      className="rounded-lg overflow-hidden"
      style={{
        background: "var(--wp-dark-surface, #151515)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
            <tr>
              {["Field", "Value", "Confidence"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="text-left px-3 py-2 whitespace-nowrap"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((f, i) => (
              <tr
                key={`${f.name}-${i}`}
                data-testid={`extracted-field-row-${f.name}`}
                style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}
              >
                <td
                  className="px-3 py-2 align-top whitespace-nowrap"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {humanizeFieldName(f.name)}
                </td>
                <td
                  className="px-3 py-2 align-top break-words"
                  style={{
                    color: "var(--wp-text, #eee)",
                    /* Wrap long values rather than overflowing the cell. */
                    wordBreak: "break-word",
                    maxWidth: "32ch",
                  }}
                  data-testid={`extracted-field-value-${f.name}`}
                >
                  {f.value}
                </td>
                <td
                  className="px-3 py-2 align-top text-xs font-mono whitespace-nowrap"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                  data-testid={`extracted-field-confidence-${f.name}`}
                >
                  {pct(f.confidence)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
