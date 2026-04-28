"use client";

/**
 * /support/patterns — operator-facing management page for the support
 * pattern library.
 *
 * Lets the operator:
 *   - See every seeded pattern (enabled and disabled).
 *   - Toggle `enabled` so the matcher considers the pattern.
 *   - Toggle `auto_acknowledge_enabled` per pattern so the inbox poller
 *     is allowed to send a customer-visible auto-ack reply when the
 *     pattern matches. Default OFF — operators MUST opt in per pattern.
 *   - Edit the `auto_acknowledge_template` text the AI uses as its
 *     starting point.
 *
 * Auth: redirects unauthenticated visitors to /login?next=/support/patterns
 * BEFORE rendering, per the dashboard convention. We never render an
 * empty 200 page when the user has no token.
 *
 * Accessibility: each row is its own list item with a header + toggles
 * + an expandable edit panel. The save button announces itself as
 * pressed via aria-label so screen readers don't lose state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import type { SupportPattern } from "@/lib/support/types";
import PatternRow from "./_components/PatternRow";

interface ListResponse {
  patterns: SupportPattern[];
  total: number;
}

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

export default function SupportPatternsPage() {
  const [patterns, setPatterns] = useState<SupportPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/support/patterns");
      if (!res.ok) {
        setError(
          "We couldn't load the pattern library right now. Refresh the page in a moment.",
        );
        return;
      }
      const data = (await res.json()) as ListResponse;
      setPatterns(Array.isArray(data.patterns) ? data.patterns : []);
    } catch (err) {
      setError(
        `Something went wrong loading the pattern library: ${(err as Error).message}`,
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
    void load();
  }, [authChecked, load]);

  const onPatched = useCallback((updated: SupportPattern) => {
    setPatterns((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
  }, []);

  /* Headline counts give the operator a one-glance read of what's
     currently allowed to auto-respond to customers. */
  const counts = useMemo(() => {
    let enabled = 0;
    let autoAck = 0;
    for (const p of patterns) {
      if (p.enabled) enabled += 1;
      if (p.auto_acknowledge_enabled === true) autoAck += 1;
    }
    return { total: patterns.length, enabled, autoAck };
  }, [patterns]);

  if (!authChecked) {
    return null;
  }

  return (
    <main
      data-testid="support-patterns-page"
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
          <h1 style={{ margin: 0, fontSize: "1.8rem" }}>
            Support patterns
          </h1>
          <p
            style={{
              marginTop: "0.4rem",
              marginBottom: 0,
              color: "var(--wp-text-dim)",
              maxWidth: "62ch",
              lineHeight: 1.45,
            }}
          >
            Patterns drive the AI draft response and decide which customer
            emails get an immediate auto-acknowledgement. Auto-ack is OFF
            by default. Opt a pattern in only after you have read its
            template and you trust the wording.
          </p>
        </div>
        <Link
          href="/support"
          data-testid="support-patterns-back"
          style={{
            background: "transparent",
            color: "var(--wp-text-dim)",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            padding: "0.55rem 1rem",
            borderRadius: 6,
            fontWeight: 500,
            fontSize: "0.88rem",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Back to tickets
        </Link>
      </header>

      <section
        data-testid="support-patterns-summary"
        aria-label="Pattern library counts"
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "1.2rem",
        }}
      >
        <SummaryPill
          testId="support-patterns-summary-total"
          label="Total"
          value={counts.total}
          tone="neutral"
        />
        <SummaryPill
          testId="support-patterns-summary-enabled"
          label="Enabled"
          value={counts.enabled}
          tone="info"
        />
        <SummaryPill
          testId="support-patterns-summary-auto-ack"
          label="Auto-ack on"
          value={counts.autoAck}
          tone={counts.autoAck > 0 ? "good" : "muted"}
        />
      </section>

      {loading ? (
        <p
          data-testid="support-patterns-loading"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Loading patterns…
        </p>
      ) : error ? (
        <div
          data-testid="support-patterns-error"
          role="alert"
          style={{
            background: "rgba(232,123,123,0.12)",
            border: "1px solid rgba(232,123,123,0.45)",
            color: "rgb(232,150,150)",
            padding: "0.7rem 0.9rem",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      ) : patterns.length === 0 ? (
        <p
          data-testid="support-patterns-empty"
          style={{ color: "var(--wp-text-dim)" }}
        >
          No patterns yet.
        </p>
      ) : (
        <ul
          data-testid="support-patterns-list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.7rem",
          }}
        >
          {patterns.map((p) => (
            <PatternRow key={p.id} pattern={p} onPatched={onPatched} />
          ))}
        </ul>
      )}
    </main>
  );
}

interface SummaryPillProps {
  testId: string;
  label: string;
  value: number;
  tone: "neutral" | "info" | "good" | "muted";
}

function SummaryPill({ testId, label, value, tone }: SummaryPillProps) {
  const palette =
    tone === "good"
      ? {
          bg: "rgba(80,175,110,0.14)",
          border: "rgba(80,175,110,0.45)",
          text: "rgb(120,210,150)",
        }
      : tone === "info"
        ? {
            bg: "rgba(82,154,232,0.12)",
            border: "rgba(82,154,232,0.4)",
            text: "rgb(140,185,235)",
          }
        : tone === "muted"
          ? {
              bg: "rgba(160,168,180,0.14)",
              border: "rgba(160,168,180,0.4)",
              text: "rgb(180,186,195)",
            }
          : {
              bg: "var(--wp-dark-surface)",
              border: "var(--wp-border, var(--wp-dark-border))",
              text: "var(--wp-text)",
            };

  return (
    <span
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        background: palette.bg,
        color: palette.text,
        border: `1px solid ${palette.border}`,
        padding: "0.35rem 0.75rem",
        borderRadius: 999,
        fontSize: "0.82rem",
        fontWeight: 600,
      }}
    >
      <span>{label}</span>
      <span data-testid={`${testId}-value`}>{value}</span>
    </span>
  );
}
