"use client";

/**
 * ClassificationCard — pure presentational view of one classification.
 *
 * Props are owned by RecognizeView. This component never talks to the
 * network directly; it bubbles correction events back up through
 * onCorrected so the parent can PATCH the API and own the optimiztic
 * update path. Keeping presentational and effectful logic apart makes
 * the card trivially testable.
 */

import { useState } from "react";
import {
  type DocumentClassification,
  type DocumentType,
  DOCUMENT_TYPES,
} from "@/lib/document-recognition/types";

interface Props {
  classification: DocumentClassification;
  recognitionId: string;
  onCorrected: (correctedType: DocumentType) => void;
}

/** Map enum value → human label. Exported for the test file's use. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  receipt: "Receipt",
  invoice: "Invoice",
  tax_w2: "W-2 Tax Form",
  tax_1099: "1099 Tax Form",
  id_document: "ID Document",
  unknown: "Unknown",
};

function humanType(t: DocumentType): string {
  return DOCUMENT_TYPE_LABELS[t] ?? t;
}

function pct(confidence: number): string {
  /* Clamp into 0..1 then round to integer percent — confidences from
     the classifier are bounded by contract, but a misbehaving
     extractor would otherwise produce "127%" badges. */
  const c = Math.max(0, Math.min(1, confidence));
  return `${Math.round(c * 100)}%`;
}

export function ClassificationCard({
  classification,
  recognitionId,
  onCorrected,
}: Props) {
  const [corrected, setCorrected] = useState(false);
  const [selectedType, setSelectedType] = useState<DocumentType>(
    classification.type,
  );

  /* If the parent passes a new classification (e.g. on rollback), keep
     the dropdown in sync — but only when the type genuinely changed. */
  if (classification.type !== selectedType && !corrected) {
    /* Bare assign during render is OK here: it's a derived-state sync
       pattern that updates a single primitive. React will re-render
       once. We guard with `!corrected` so we don't fight the user. */
    setSelectedType(classification.type);
  }

  return (
    <div
      data-testid="classification-card"
      className="rounded-lg p-4 space-y-3"
      style={{
        background: "var(--wp-dark-surface, #151515)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            data-testid="classification-type-label"
            className="text-base font-semibold"
            style={{ color: "var(--wp-text, #eee)" }}
          >
            {humanType(classification.type)}
          </span>
          <span
            data-testid="classification-confidence-badge"
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{
              background: "rgba(74,222,128,0.10)",
              color: "#4ade80",
              border: "1px solid #4ade80",
            }}
          >
            {pct(classification.confidence)}
          </span>
          {corrected && (
            <span
              data-testid="classification-corrected-indicator"
              className="rounded px-2 py-0.5 text-xs font-medium"
              style={{
                background: "rgba(96,165,250,0.10)",
                color: "#60a5fa",
                border: "1px solid #60a5fa",
              }}
              title="You corrected this classification"
            >
              Corrected
            </span>
          )}
        </div>
      </div>

      {classification.rationale && (
        <p
          data-testid="classification-rationale"
          className="text-xs"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          {classification.rationale}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label
          htmlFor={`reclassify-${recognitionId}`}
          className="text-xs"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          Reclassify as:
        </label>
        <select
          id={`reclassify-${recognitionId}`}
          data-testid="classification-reclassify-select"
          value={selectedType}
          onChange={(e) => {
            const next = e.target.value as DocumentType;
            setSelectedType(next);
            /* Don't bubble a no-op correction back up. */
            if (next !== classification.type) {
              setCorrected(true);
              onCorrected(next);
            }
          }}
          className="text-xs rounded px-2 py-1"
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text, #eee)",
          }}
        >
          {DOCUMENT_TYPES.map((t) => (
            <option
              key={t}
              value={t}
              data-testid={`classification-reclassify-option-${t}`}
            >
              {humanType(t)}
            </option>
          ))}
        </select>
      </div>

      {classification.model && (
        <div
          className="text-[11px]"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
          data-testid="classification-model-meta"
        >
          {classification.model} · {classification.latencyMs}ms ·{" "}
          {(classification.costCents / 100).toFixed(3)} USD
        </div>
      )}
    </div>
  );
}
