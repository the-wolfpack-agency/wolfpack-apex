import { fetchWithRefresh } from "@/lib/client-auth";
"use client";

/**
 * TeamsMeetingToggle — wraps the "Online meeting (Teams)" control.
 *
 * Stream A shipped a permanently-disabled tooltip-gated toggle in
 * `EventModal.tsx`. Now that Tier 2 · Stream E adds the
 * `OnlineMeetings.ReadWrite.All` scope, this component replaces that
 * disabled input with a functional one IF the server reports the
 * `onlineMeetings` capability. Otherwise it falls back to the disabled
 * tooltip Stream A rendered — no regression.
 *
 * Consumers should use this component anywhere a Teams-meeting toggle is
 * offered. EventModal.tsx integration is intentionally NOT part of this
 * stream (Stream A owns that file) — this stays a drop-in wrapper.
 */

import { useEffect, useState } from "react";

export interface TeamsMeetingToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Pass `getToken()` from the app shell if you don't use localStorage. */
  getAuthHeader?: () => string | null;
  /** Optional capability override (useful in tests). */
  capabilityOverride?: boolean;
}

function defaultAuth(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = window.localStorage.getItem("instinct_token");
    return t ? `Bearer ${t}` : null;
  } catch {
    return null;
  }
}

export default function TeamsMeetingToggle({
  checked,
  onChange,
  getAuthHeader,
  capabilityOverride,
}: TeamsMeetingToggleProps) {
  const [enabled, setEnabled] = useState<boolean | null>(
    capabilityOverride ?? null,
  );

  useEffect(() => {
    if (capabilityOverride !== undefined) {
      setEnabled(capabilityOverride);
      return;
    }
    let cancelled = false;
    async function probe() {
      try {
        const auth = (getAuthHeader ?? defaultAuth)();
        const res = await fetchWithRefresh("/api/config/ms-capabilities", {
          headers: auth ? { authorization: auth } : undefined,
        });
        if (cancelled) return;
        if (!res.ok) {
          setEnabled(false);
          return;
        }
        const data = (await res.json()) as { onlineMeetings?: boolean };
        setEnabled(Boolean(data.onlineMeetings));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    }
    probe();
    return () => {
      cancelled = true;
    };
  }, [capabilityOverride, getAuthHeader]);

  const isEnabled = enabled === true;
  const title = isEnabled
    ? "Attach a Teams online meeting to this event"
    : "Available after Teams scope is granted";

  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        opacity: isEnabled ? 1 : 0.6,
      }}
      title={title}
      data-testid="online-meeting-label"
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!isEnabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label="Online meeting"
        data-testid="online-meeting-toggle"
      />
      <span>
        Online meeting (Teams)
        {!isEnabled && (
          <em style={{ fontSize: "0.75rem" }}>
            {" "}
            — Available after Teams scope is granted
          </em>
        )}
      </span>
    </label>
  );
}
