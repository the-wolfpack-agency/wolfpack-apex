/**
 * GlassPanel — frosted dark-glass container, the base surface every other
 * command-center primitive sits on.
 *
 * Aesthetic (built on the existing --wp-* tokens, never a raw hex):
 *   - subtle backdrop-filter blur over a translucent --wp-dark-surface
 *   - 1px --wp-dark-border outline
 *   - faint inner top highlight so it reads as a pane of glass, not a flat box
 *   - optional gold / blue edge glow for "focused" or "live" panels
 *
 * The blur + glow live in the `.wp-glass` utility class (globals.css) so the
 * compositor handles it and reduced-motion / no-backdrop-filter degrade
 * gracefully. Pure presentational: no fetching, no analytics.
 */

"use client";

import type { CSSProperties, ReactNode } from "react";

export type GlassGlow = "gold" | "blue" | "none";

export interface GlassPanelProps {
  /** Optional header title. When set, a header row renders above children. */
  title?: ReactNode;
  /** Optional sub-line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned actions slot in the header row (buttons, filters, …). */
  actions?: ReactNode;
  /** Edge glow accent. Default "none". */
  glow?: GlassGlow;
  /** Extra classes merged after the glass utility. */
  className?: string;
  /** Inline style overrides (merged last). */
  style?: CSSProperties;
  /** Body padding. Defaults to comfortable 16px; pass 0 for flush content. */
  padded?: boolean;
  testId?: string;
  children?: ReactNode;
}

export function GlassPanel({
  title,
  subtitle,
  actions,
  glow = "none",
  className,
  style,
  padded = true,
  testId,
  children,
}: GlassPanelProps) {
  const glowClass =
    glow === "gold"
      ? "wp-glass-glow-gold"
      : glow === "blue"
        ? "wp-glass-glow-blue"
        : "";
  const merged = ["wp-glass", glowClass, className].filter(Boolean).join(" ");
  const hasHeader = title != null || subtitle != null || actions != null;

  return (
    <section
      data-testid={testId ?? "glass-panel"}
      data-glow={glow}
      className={merged}
      style={style}
    >
      {hasHeader && (
        <header
          data-testid="glass-panel-header"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 16px",
            borderBottom: "1px solid var(--wp-dark-border, #242a36)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title != null && (
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--wp-text, #e9edf4)",
                  letterSpacing: "0.01em",
                }}
              >
                {title}
              </div>
            )}
            {subtitle != null && (
              <div
                style={{
                  marginTop: 2,
                  fontSize: 12,
                  color: "var(--wp-text-muted, #929cad)",
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {actions != null && (
            <div
              data-testid="glass-panel-actions"
              style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
            >
              {actions}
            </div>
          )}
        </header>
      )}
      <div style={{ padding: padded ? 16 : 0 }}>{children}</div>
    </section>
  );
}

export default GlassPanel;
