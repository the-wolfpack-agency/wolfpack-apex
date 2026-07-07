"use client";

/**
 * /invoices — index for the Invoices tab. Lists the trackers the signed-in user
 * may access (PCNA today; more companies later, same tab). Access is decided by
 * the API (per-tracker email allowlist); this page just renders what it returns.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface TrackerLink {
  id: string;
  company: string;
}

export default function InvoicesIndexPage() {
  const router = useRouter();
  const [trackers, setTrackers] = useState<TrackerLink[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/invoices");
        if (!active) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = (await res.json()) as { trackers: TrackerLink[] };
        setTrackers(body.trackers ?? []);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex-1 p-4 md:p-6" data-testid="invoices-index-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>Invoices</h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Read-only mirrors of the budget &amp; SOW invoice workbooks, synced live from SharePoint.
        </p>
      </header>

      {error ? (
        <p className="text-sm" style={{ color: "var(--wp-error, #ef4444)" }} data-testid="invoices-index-error">
          Couldn’t load your invoice trackers. Please refresh.
        </p>
      ) : trackers === null ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>
      ) : trackers.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="invoices-index-empty">
          You don’t have access to any invoice trackers.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="invoices-index-list">
          {trackers.map((t) => (
            <li key={t.id}>
              <a
                href={`/invoices/${t.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  router.push(`/invoices/${t.id}`);
                }}
                data-testid="invoices-index-item"
                className="block p-4 rounded-lg"
                style={{ background: "var(--wp-surface, #1a1a1a)", border: "1px solid var(--wp-border, #333)", color: "var(--wp-text, #eee)" }}
              >
                <span className="font-semibold">{t.company}</span>
                <span className="block text-xs mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>Invoice tracker</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
