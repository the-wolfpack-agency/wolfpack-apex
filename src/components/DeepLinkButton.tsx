"use client";

/**
 * DeepLinkButton — opens a Teams deep-link URL in a new tab and fires
 * an analytics event. Used by the Messages page for reply/call/video
 * actions that hand off to the Teams desktop or web client.
 *
 * Analytics: POST /api/analytics with event
 *   "messages.deep_link_clicked", metadata: { type }
 *
 * Never throws from the call site. Analytics failure is swallowed so
 * the deep-link still opens.
 *
 * Styling: secondary button with dark-theme CSS vars — bordered,
 * rounded, muted text, icon-left / text-right, hover brightens. The
 * earlier version rendered with no styles at all and looked like plain
 * inline text on the dashboard (April-23 UI regression). This component
 * now owns its own look so callers can not reintroduce the regression
 * by forgetting a className.
 */

import { ReactNode, CSSProperties } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface DeepLinkButtonProps {
  url: string;
  analyticsType: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  testId?: string;
  /**
   * Screen-reader label. Lets distinct buttons ("Reply in Teams" vs
   * "Call" vs "Video call") be disambiguated by AT when their visible
   * text is similar or icon-only.
   */
  ariaLabel?: string;
  /**
   * Optional leading icon. Falls back to a small external-link glyph so
   * the button always renders icon-left / text-right even when callers
   * don't supply one.
   */
  icon?: ReactNode;
}

const baseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  fontSize: 12,
  lineHeight: 1.2,
  borderRadius: 6,
  border: "1px solid var(--wp-dark-border, #333)",
  background: "var(--wp-dark-surface2, #222)",
  color: "var(--wp-text-muted, #9ca3af)",
  cursor: "pointer",
  textDecoration: "none",
  whiteSpace: "nowrap",
  transition: "filter 120ms ease, color 120ms ease",
};

const disabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

function DefaultIcon() {
  // Inline SVG — no icon-lib dep. 12x12 "external link" glyph.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export default function DeepLinkButton({
  url,
  analyticsType,
  children,
  disabled,
  className,
  testId,
  ariaLabel,
  icon,
}: DeepLinkButtonProps) {
  const isDisabled = Boolean(disabled) || !url;

  function handleClick() {
    if (isDisabled) return;

    // Fire-and-forget analytics; don't block the user action.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "messages.deep_link_clicked",
        metadata: { type: analyticsType },
      }),
    }).catch(() => undefined);

    // Open in a new tab. noopener/noreferrer per standard security hygiene.
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function handleMouseEnter(e: React.MouseEvent<HTMLButtonElement>) {
    if (isDisabled) return;
    e.currentTarget.style.filter = "brightness(1.25)";
    e.currentTarget.style.color = "var(--wp-text, #eee)";
  }
  function handleMouseLeave(e: React.MouseEvent<HTMLButtonElement>) {
    e.currentTarget.style.filter = "";
    e.currentTarget.style.color = "var(--wp-text-muted, #9ca3af)";
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      disabled={isDisabled}
      data-testid={testId ?? `deep-link-${analyticsType}`}
      data-href={url}
      aria-label={ariaLabel}
      className={className}
      style={{ ...baseStyle, ...(isDisabled ? disabledStyle : {}) }}
    >
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        {icon ?? <DefaultIcon />}
      </span>
      <span>{children}</span>
    </button>
  );
}
