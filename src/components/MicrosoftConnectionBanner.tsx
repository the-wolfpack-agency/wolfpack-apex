"use client";

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

/**
 * MicrosoftConnectionBanner
 *
 * Makes a revoked / expired Microsoft 365 token loud instead of silent.
 *
 * Before this banner, a disconnected MS token just blanked the user's
 * calendar, mail, and tasks widgets with no on-screen signal - the user
 * had no idea WHY their day was empty (the April-class "blank, no reason"
 * UX failure this team hard-bans).
 *
 * Behavior:
 *   - On mount, reads GET /api/integrations/status (via fetchWithRefresh,
 *     never raw fetch - authenticated endpoint) and inspects
 *     `microsoft.connected`.
 *   - While the status call is in flight, or on ANY error, renders null.
 *     The banner must never block or crash the dashboard.
 *   - When `microsoft.connected === false`, renders a prominent warning
 *     banner with a "Reconnect Microsoft" action.
 *   - When connected, renders null.
 *   - Reconnect fetches GET /api/auth/microsoft-start for the Azure
 *     authUrl, then navigates the browser there. Errors surface inline,
 *     they never throw.
 *   - Dismissable for the session (component state). It reappears on the
 *     next dashboard load if Microsoft is still disconnected.
 *
 * Warning palette uses the dark-theme amber/warning tokens (var(--wp-*)),
 * never green and never hard-coded hex.
 */

interface IntegrationsStatus {
  microsoft?: { connected?: boolean };
}

interface MicrosoftStartResponse {
  authUrl?: string;
}

export default function MicrosoftConnectionBanner() {
  // null = unknown / still loading / errored - render nothing in all three.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchWithRefresh("/api/integrations/status")
      .then((res) => {
        if (!res.ok) throw new Error("status request failed");
        return res.json();
      })
      .then((data: IntegrationsStatus) => {
        if (!active) return;
        // Only flip to "disconnected" when the contract explicitly says so.
        // Anything ambiguous (missing field, malformed body) stays null so
        // we never show a false "disconnected" alarm.
        if (typeof data?.microsoft?.connected === "boolean") {
          setConnected(data.microsoft.connected);
        }
      })
      .catch(() => {
        // Graceful: a failing status call must not surface the banner or
        // crash the dashboard. Stay silent (connected stays null).
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleReconnect() {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectError(null);
    try {
      const res = await fetchWithRefresh("/api/auth/microsoft-start");
      if (!res.ok) throw new Error("start request failed");
      const data: MicrosoftStartResponse = await res.json();
      if (!data?.authUrl) throw new Error("no authUrl in response");
      window.location.href = data.authUrl;
    } catch {
      setReconnectError(
        "Could not start the reconnect flow. Please try again in a moment.",
      );
      setReconnecting(false);
    }
  }

  // Loading, errored, connected, or dismissed: render nothing.
  if (dismissed) return null;
  if (connected !== false) return null;

  return (
    <div
      data-testid="ms-disconnected-banner"
      role="alert"
      style={{
        padding: "1rem 1.25rem",
        background: "rgba(245, 158, 11, 0.08)",
        border: "1px solid var(--wp-warning)",
        borderRadius: "10px",
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          fontSize: 18,
          lineHeight: "1.4",
          color: "var(--wp-warning)",
        }}
      >
        &#9888;
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--wp-warning)" }}>
          Microsoft 365 is disconnected
        </div>
        <div style={{ fontSize: 13, marginTop: 4, color: "var(--wp-text-dim)" }}>
          Reconnect to restore your calendar, mail, and tasks.
        </div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid="ms-reconnect-btn"
            onClick={handleReconnect}
            disabled={reconnecting}
            style={{
              background: "var(--wp-warning)",
              color: "var(--wp-dark)",
              border: "none",
              borderRadius: 8,
              padding: "0.5rem 0.9rem",
              fontSize: 13,
              fontWeight: 600,
              cursor: reconnecting ? "default" : "pointer",
              opacity: reconnecting ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {reconnecting ? "Reconnecting..." : "Reconnect Microsoft"}
          </button>
          {reconnectError ? (
            <span
              data-testid="ms-reconnect-error"
              style={{ fontSize: 12, color: "var(--wp-error)" }}
            >
              {reconnectError}
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        data-testid="ms-banner-dismiss"
        aria-label="Dismiss Microsoft 365 disconnected banner"
        onClick={() => setDismissed(true)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--wp-text-dim)",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: 4,
          flexShrink: 0,
        }}
      >
        &#215;
      </button>
    </div>
  );
}
