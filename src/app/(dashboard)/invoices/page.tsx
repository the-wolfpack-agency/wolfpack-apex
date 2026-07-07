"use client";

/**
 * /invoices — the Invoices hub. One home for every invoice surface, shown as
 * sub-page cards the signed-in user may actually open:
 *   - "Vendor Invoices": the AP upload/scan queue (finance.invoices.view).
 *   - one card per read-only SharePoint tracker (PCNA today; more companies
 *     later, same hub) — gated by the per-tracker email allowlist server-side.
 * The cards are decided by the API + capabilities, never by this page, so access
 * can't drift. Authed fetches go through fetchWithRefresh (repo guardrail).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface TrackerLink {
  id: string;
  company: string;
}

interface Card {
  href: string;
  title: string;
  subtitle: string;
}

export default function InvoicesHubPage() {
  const router = useRouter();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [trackersRes, capsRes] = await Promise.all([
          fetchWithRefresh("/api/invoices"),
          fetchWithRefresh("/api/me/capabilities"),
        ]);
        if (!active) return;

        const built: Card[] = [];

        // Vendor AP queue — only if the caller can view finance invoices.
        if (capsRes.ok) {
          const caps = (await capsRes.json()) as { capabilities?: string[] };
          if (caps.capabilities?.includes("finance.invoices.view")) {
            built.push({
              href: "/invoices/vendor",
              title: "Vendor Invoices",
              subtitle: "AP queue — upload, review, approve, mark paid",
            });
          }
        }

        // Read-only SharePoint trackers the caller is allowlisted for.
        if (trackersRes.ok) {
          const body = (await trackersRes.json()) as { trackers?: TrackerLink[] };
          for (const t of body.trackers ?? []) {
            built.push({
              href: `/invoices/${t.id}`,
              title: t.company,
              subtitle: "Invoice tracker — live SharePoint mirror",
            });
          }
        }

        if (!trackersRes.ok && !capsRes.ok) setError(true);
        setCards(built);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex-1 p-4 md:p-6" data-testid="invoices-hub-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>Invoices</h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Accounts-payable queue and read-only SharePoint invoice mirrors, all in one place.
        </p>
      </header>

      {error ? (
        <p className="text-sm" style={{ color: "var(--wp-error, #ef4444)" }} data-testid="invoices-hub-error">
          Couldn&apos;t load your invoice pages. Please refresh.
        </p>
      ) : cards === null ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>
      ) : cards.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="invoices-hub-empty">
          You don&apos;t have access to any invoice pages.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="invoices-hub-list">
          {cards.map((c) => (
            <li key={c.href}>
              <a
                href={c.href}
                onClick={(e) => {
                  e.preventDefault();
                  router.push(c.href);
                }}
                data-testid="invoices-hub-card"
                className="block p-4 rounded-lg transition-colors"
                style={{ background: "var(--wp-surface, #1a1a1a)", border: "1px solid var(--wp-border, #333)", color: "var(--wp-text, #eee)" }}
              >
                <span className="font-semibold">{c.title}</span>
                <span className="block text-xs mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>{c.subtitle}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
