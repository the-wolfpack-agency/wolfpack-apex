"use client";

/**
 * PresenceIndicator — colored dot + label for the current user's MS
 * presence. Polls /api/presence/me every 30 seconds.
 */

import { useEffect, useState } from "react";
import { authHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface Presence {
  availability: string;
  activity: string;
  statusMessage: string | null;
  fetchedAt: string;
}

const POLL_MS = 60_000; // 2026-05-23: 30→60 to halve dashboard idle traffic

function dotColor(availability: string): string {
  switch (availability) {
    case "Available":
    case "AvailableIdle":
      return "#22c55e";
    case "Busy":
    case "BusyIdle":
    case "DoNotDisturb":
      return "#ef4444";
    case "Away":
    case "BeRightBack":
      return "#f59e0b";
    case "Offline":
      return "#9ca3af";
    default:
      return "#d1d5db";
  }
}

function prettyLabel(p: Presence): string {
  if (p.statusMessage) return p.statusMessage;
  if (p.activity && p.activity !== "PresenceUnknown") {
    return p.activity.replace(/([A-Z])/g, " $1").trim();
  }
  return p.availability.replace(/([A-Z])/g, " $1").trim();
}

export default function PresenceIndicator() {
  const [presence, setPresence] = useState<Presence | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    async function fetchPresence() {
      try {
        const res = await fetchWithRefresh("/api/presence/me", { headers: authHeaders() });
        if (!res.ok) {
          if (active) { setPresence(null); setLoaded(true); }
          return;
        }
        const data = (await res.json()) as { presence?: Presence | null };
        if (active) {
          setPresence(data.presence ?? null);
          setLoaded(true);
        }
      } catch {
        if (active) { setLoaded(true); }
      }
    }
    fetchPresence();
    const id = setInterval(fetchPresence, POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (!loaded) return null;
  if (!presence) {
    return (
      <span aria-label="Presence unavailable" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: "#d1d5db" }} />
        <span style={{ fontSize: 12, color: "#6b7280" }}>Unavailable</span>
      </span>
    );
  }

  const color = dotColor(presence.availability);
  const label = prettyLabel(presence);

  return (
    <span
      aria-label={`Presence: ${label}`}
      data-availability={presence.availability}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
      <span style={{ fontSize: 12 }}>{label}</span>
    </span>
  );
}
