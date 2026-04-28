"use client";

/**
 * /support — list view of every support ticket the operator has access
 * to. Mirrors the filter-pill + clickable-row pattern used in
 * /automations/porsche-classes for visual consistency.
 *
 * Filter pills change the `?status=` query param sent to the API. The
 * "All" pill sends no `status` filter so the backend can return every
 * ticket regardless of state.
 *
 * Auth: redirects unauthenticated visitors to /login?next=/support
 * BEFORE rendering, per the dashboard convention. We never render an
 * empty 200 page when the user has no token.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import TicketList, {
  type FilterKey,
  type SupportTicket,
} from "./_components/TicketList";

interface ListResponse {
  tickets: SupportTicket[];
  total: number;
}

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

/** Map a UI filter key to the API ?status= value (or none, for "all"). */
function statusQueryFor(filter: FilterKey): string | null {
  switch (filter) {
    case "all":
      return null;
    case "resolved":
      /* "Resolved" is a virtual bucket that includes both `resolved`
         and `closed` so stale tickets aren't lost from the UI. The
         server sees the canonical status; the union is computed
         client-side after the fetch. */
      return "resolved";
    default:
      return filter;
  }
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const load = useCallback(async (currentFilter: FilterKey) => {
    setLoading(true);
    setError(null);
    try {
      const status = statusQueryFor(currentFilter);
      const url = status
        ? `/api/support/tickets?status=${encodeURIComponent(status)}`
        : "/api/support/tickets";
      const res = await fetchWithRefresh(url);
      if (!res.ok) {
        setError(
          `We couldn't load your tickets right now. Refresh the page in a moment.`,
        );
        return;
      }
      const data = (await res.json()) as ListResponse;
      setTickets(Array.isArray(data.tickets) ? data.tickets : []);
    } catch (err) {
      setError(
        `Something went wrong loading tickets: ${(err as Error).message}`,
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
    if (!authChecked) return;
    void load(filter);
  }, [authChecked, filter, load]);

  if (!authChecked) {
    /* Render nothing while we decide whether to redirect — keeps the
       page from flashing content to a logged-out visitor. */
    return null;
  }

  return (
    <main
      data-testid="support-page"
      style={{
        padding: "2rem",
        maxWidth: 960,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.4rem",
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ margin: 0, fontSize: "1.8rem" }}>Support</h1>
          <p
            style={{
              marginTop: "0.4rem",
              marginBottom: 0,
              color: "var(--wp-text-dim)",
              maxWidth: "62ch",
              lineHeight: 1.45,
            }}
          >
            Track support requests, review the AI-drafted response, edit
            it before it goes out, and confirm whether it actually
            helped. Every rating teaches the system what to draft next
            time.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Link
            href="/support/analytics"
            data-testid="support-view-analytics-cta"
            style={{
              background: "transparent",
              color: "var(--wp-text-dim)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              padding: "0.6rem 1rem",
              borderRadius: 6,
              fontWeight: 500,
              fontSize: "0.88rem",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            View AI savings
          </Link>
          <Link
            href="/support/patterns"
            data-testid="support-manage-patterns-cta"
            style={{
              background: "transparent",
              color: "var(--wp-text-dim)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              padding: "0.6rem 1rem",
              borderRadius: 6,
              fontWeight: 500,
              fontSize: "0.88rem",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Manage patterns
          </Link>
          <Link
            href="/support/new"
            data-testid="support-new-cta"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              padding: "0.65rem 1.2rem",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: "0.92rem",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            + New ticket
          </Link>
        </div>
      </header>

      <TicketList
        tickets={tickets}
        filter={filter}
        onFilterChange={setFilter}
        loading={loading}
        error={error}
      />
    </main>
  );
}
