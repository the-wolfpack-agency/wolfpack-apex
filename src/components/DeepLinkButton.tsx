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
 */

import { ReactNode } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface DeepLinkButtonProps {
  url: string;
  analyticsType: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

export default function DeepLinkButton({
  url,
  analyticsType,
  children,
  disabled,
  className,
  testId,
}: DeepLinkButtonProps) {
  function handleClick() {
    if (disabled || !url) return;

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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || !url}
      data-testid={testId ?? `deep-link-${analyticsType}`}
      data-href={url}
      className={className}
    >
      {children}
    </button>
  );
}
