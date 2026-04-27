"use client";

/**
 * /support/[id] — ticket detail page.
 *
 * Wraps <TicketDetail /> and owns:
 *   - Auth gate (redirect to /login?next=… if no token).
 *   - Initial GET /api/support/tickets/[id] fetch.
 *   - Holding the canonical ticket in state and passing an
 *     onTicketUpdated callback so children can swap in a fresher
 *     version after regenerate / send / feedback round-trips.
 *
 * The page intentionally does NOT refetch after every mutation — every
 * mutating endpoint already returns the new ticket shape, so we treat
 * those responses as authoritative and apply them optimistically.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import TicketDetail from "../_components/TicketDetail";
import type { SupportTicket } from "../_components/TicketList";

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

export default function SupportTicketPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const load = useCallback(async (ticketId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/support/tickets/${encodeURIComponent(ticketId)}`,
      );
      if (res.status === 404) {
        setError("We couldn't find that ticket. It may have been deleted.");
        setTicket(null);
        return;
      }
      if (!res.ok) {
        setError(
          "We couldn't load the ticket right now. Refresh the page in a moment.",
        );
        return;
      }
      const data = (await res.json()) as SupportTicket;
      setTicket(data);
    } catch (err) {
      setError(
        `Something went wrong loading the ticket: ${(err as Error).message}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  useEffect(() => {
    if (!authChecked || !id) return;
    void load(id);
  }, [authChecked, id, load]);

  if (!authChecked) return null;

  return (
    <main
      data-testid="support-ticket-page"
      style={{
        padding: "2rem",
        maxWidth: 820,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <Link
        href="/support"
        data-testid="support-ticket-back"
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
          display: "inline-block",
          padding: "0.5rem 0.4rem",
          margin: "-0.5rem -0.4rem 0.4rem",
          touchAction: "manipulation",
        }}
      >
        ← Back to Support
      </Link>

      {loading && (
        <p
          data-testid="support-ticket-loading"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Loading ticket…
        </p>
      )}

      {error && (
        <div
          role="alert"
          data-testid="support-ticket-error"
          style={{
            padding: "0.7rem 0.9rem",
            background: "rgba(232,123,123,0.10)",
            border: "1px solid rgba(232,123,123,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            color: "var(--wp-text)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && ticket && (
        <TicketDetail ticket={ticket} onTicketUpdated={setTicket} />
      )}
    </main>
  );
}
