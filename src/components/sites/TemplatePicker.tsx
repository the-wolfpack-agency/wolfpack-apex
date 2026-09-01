"use client";

/**
 * TemplatePicker — Canva-style starter-template grid for /sites/new.
 *
 * Accessibility:
 *   - Each card renders as a <button> (keyboard + screen-reader friendly).
 *   - Each card has an `aria-label` with the template name.
 *   - Enter and Space on a focused card select the template (default
 *     browser behavior for <button>).
 *
 * Analytics:
 *   - Fires `site.template_previewed` on select — fire-and-forget to
 *     /api/analytics. Tells the learning loop which templates the team
 *     considers, even if they don't end up picking one.
 */

import { listTemplates, type SiteTemplateMeta } from "@/lib/site-templates";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

export interface TemplatePickerProps {
  /** Called with the chosen template id when a card is clicked. */
  onSelect: (templateId: string) => void;
  /** Optionally disable all cards (e.g. while the form is submitting). */
  disabled?: boolean;
}

function firePreviewEvent(templateId: string): void {
  // Fire-and-forget. Analytics must never block the UI.
  try {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "site.template_previewed",
        metadata: { template_id: templateId },
      }),
    }).catch(() => {});
  } catch {
    /* swallow — analytics is best-effort */
  }
}

export default function TemplatePicker({ onSelect, disabled = false }: TemplatePickerProps) {
  const templates: SiteTemplateMeta[] = listTemplates();

  return (
    <div
      role="list"
      aria-label="Site starter templates"
      data-testid="template-picker"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "1rem",
      }}
    >
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          role="listitem"
          data-testid={`template-card-${t.id}`}
          data-template-id={t.id}
          aria-label={`Use template: ${t.name}`}
          disabled={disabled}
          onClick={() => {
            firePreviewEvent(t.id);
            onSelect(t.id);
          }}
          style={{
            textAlign: "left",
            padding: "1rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
        >
          <div
            aria-hidden="true"
            data-testid={`template-thumb-${t.id}`}
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              background:
                "linear-gradient(135deg, var(--wp-gold, #d6a64a) 0%, var(--wp-dark, #1a1a1a) 100%)",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 600,
              fontSize: "0.85rem",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              padding: "0.5rem",
            }}
          >
            {t.name}
          </div>
          <div style={{ fontWeight: 600, fontSize: "1rem" }}>{t.name}</div>
          <div
            style={{
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
              lineHeight: 1.4,
            }}
          >
            {t.description}
          </div>
        </button>
      ))}
    </div>
  );
}
