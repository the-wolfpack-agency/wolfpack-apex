/**
 * SectionHeader — title + optional subtitle + right-aligned actions row.
 * One header treatment across platform-scans, agents list, and agent detail
 * so the three pages feel like one console. Pure presentational.
 */

"use client";

import type { ReactNode } from "react";

export interface SectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional small eyebrow / kicker above the title. */
  eyebrow?: ReactNode;
  /** Right-aligned actions (buttons, filters, search). */
  actions?: ReactNode;
  /** Heading level for a11y. Default 2. */
  as?: "h1" | "h2" | "h3";
  className?: string;
  testId?: string;
}

export function SectionHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  as = "h2",
  className,
  testId,
}: SectionHeaderProps) {
  const Heading = as;
  return (
    <div
      data-testid={testId ?? "section-header"}
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        marginBottom: 16,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {eyebrow != null && (
          <div
            data-testid="section-header-eyebrow"
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--wp-gold, #e8b528)",
              marginBottom: 4,
            }}
          >
            {eyebrow}
          </div>
        )}
        <Heading
          style={{
            margin: 0,
            fontSize: as === "h1" ? 22 : 18,
            fontWeight: 700,
            color: "var(--wp-text, #e9edf4)",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </Heading>
        {subtitle != null && (
          <div
            data-testid="section-header-subtitle"
            style={{
              marginTop: 4,
              fontSize: 13,
              color: "var(--wp-text-muted, #929cad)",
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {actions != null && (
        <div
          data-testid="section-header-actions"
          style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

export default SectionHeader;
