"use client";

/**
 * /automations/[automationId] — overview dashboard for one automation.
 *
 * Top-level tiles:
 *   - Classes in window
 *   - Changes today (delta count)
 *   - Open exceptions
 *
 * Quick links to /changes, /exceptions, and (Stream B) /summaries.
 *
 * "Run now" button POSTs /poll for ad-hoc ingest.
 */

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface AutomationDetail {
  id: string;
  name: string;
  owner_label: string;
  description: string;
  active_window_days: { min: number; max: number };
  source_types: string[];
  has_summary_assembler: boolean;
}

interface CountsView {
  artifacts_today: number;
  open_exceptions: number;
  classes_in_window: number;
}

export default function AutomationOverviewPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const { automationId } = use(params);
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [counts, setCounts] = useState<CountsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  type PollFeedback =
    | { kind: "info"; msg: string }
    | { kind: "ok"; msg: string }
    | { kind: "warn"; msg: string }
    | { kind: "error"; msg: string };
  const [pollResult, setPollResult] = useState<PollFeedback | null>(null);

  /* Auto-dismiss the poll-result banner after 6s on success/skip,
     longer (12s) on error so the operator can read the message. */
  useEffect(() => {
    if (!pollResult) return;
    const ms = pollResult.kind === "error" ? 12_000 : 6_000;
    const id = window.setTimeout(() => setPollResult(null), ms);
    return () => window.clearTimeout(id);
  }, [pollResult]);

  async function load() {
    setLoading(true);
    try {
      const r = await fetchWithRefresh(`/api/automations/${automationId}`);
      if (!r.ok) {
        setError(`Failed to load automation (${r.status})`);
        return;
      }
      const data = (await r.json()) as {
        automation: AutomationDetail;
        counts: CountsView;
      };
      setAutomation(data.automation);
      setCounts(data.counts);
      setError(null);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId]);

  async function handleRunNow() {
    setPolling(true);
    /* Instant click-acknowledgement so the user knows the request is
       in flight, not silently swallowed. The success/error message
       below replaces this within ~1-3s. */
    setPollResult({
      kind: "info",
      msg: "Started · checking the inbox now…",
    });
    try {
      const r = await fetchWithRefresh(
        `/api/automations/${automationId}/poll`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) {
        setPollResult({
          kind: "error",
          msg: `Failed (${r.status}): ${data.error ?? "unknown"}`,
        });
      } else {
        const res = data.result;
        if (res?.skipped === "no_user_connected" || res?.skipped === "no_valid_token") {
          setPollResult({
            kind: "warn",
            msg:
              "No mailbox connected yet. Sign in to Microsoft (top-right) and " +
              "grant Mail.Read access, then click Run now again.",
          });
        } else {
          const ing = res?.artifacts_ingested ?? 0;
          const matched = res?.messages_matched ?? 0;
          const dup = res?.artifacts_duplicate ?? 0;
          const quar = res?.artifacts_quarantined ?? 0;
          const headline =
            ing === 0 && dup === 0
              ? "Done · inbox checked, no new matching emails"
              : `Done · ingested ${ing} new artifact${ing === 1 ? "" : "s"}`;
          setPollResult({
            kind: "ok",
            msg:
              `${headline} · matched ${matched}, duplicates ${dup}, ` +
              `quarantined ${quar}`,
          });
          await load();
        }
      }
    } catch (err) {
      setPollResult({
        kind: "error",
        msg: `Network error: ${(err as Error).message}`,
      });
    } finally {
      setPolling(false);
    }
  }

  if (loading && !automation) {
    return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: "2rem", color: "#c44" }}>{error}</div>;
  }
  if (!automation || !counts) return null;

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "1.5rem",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: "200px" }}>
          <Link
            href="/automations"
            style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)", textDecoration: "none" }}
          >
            ← All automations
          </Link>
          <h1 style={{ fontSize: "1.8rem", margin: "0.3rem 0 0 0" }}>{automation.name}</h1>
          <p
            style={{
              color: "var(--wp-text-dim)",
              marginTop: "0.4rem",
              maxWidth: "60ch",
              lineHeight: 1.4,
            }}
          >
            {automation.description}
          </p>
        </div>
        <button
          onClick={handleRunNow}
          disabled={polling}
          data-testid="automation-run-now"
          aria-busy={polling}
          aria-live="polite"
          style={{
            background: polling ? "var(--wp-border)" : "var(--wp-gold)",
            outline: polling ? "2px solid var(--wp-gold)" : "none",
            outlineOffset: "2px",
            boxShadow: polling ? "0 0 0 4px rgba(229,180,69,0.18)" : "none",
            transition: "background 120ms, box-shadow 200ms, outline 120ms",
            color: polling ? "var(--wp-text-dim)" : "var(--wp-dark)",
            border: "none",
            padding: "0.6rem 1.2rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: polling ? "not-allowed" : "pointer",
          }}
        >
          {polling ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  border: "2px solid currentColor",
                  borderTopColor: "transparent",
                  animation: "wp-spin 0.7s linear infinite",
                }}
              />
              Polling…
            </span>
          ) : (
            "Run now"
          )}
          <style jsx>{`
            @keyframes wp-spin {
              to {
                transform: rotate(360deg);
              }
            }
          `}</style>
        </button>
      </div>

      {pollResult && (
        <div
          data-testid="automation-poll-result"
          data-kind={pollResult.kind}
          role="status"
          aria-live="polite"
          style={{
            padding: "0.7rem 0.9rem",
            background:
              pollResult.kind === "error"
                ? "rgba(204,68,68,0.10)"
                : pollResult.kind === "warn"
                  ? "rgba(229,180,69,0.12)"
                  : pollResult.kind === "ok"
                    ? "rgba(80,175,110,0.12)"
                    : "var(--wp-card)",
            border: `1px solid ${
              pollResult.kind === "error"
                ? "#c44"
                : pollResult.kind === "warn"
                  ? "var(--wp-gold)"
                  : pollResult.kind === "ok"
                    ? "rgba(80,175,110,0.55)"
                    : "var(--wp-border)"
            }`,
            borderLeftWidth: "4px",
            borderRadius: "6px",
            color: "var(--wp-text)",
            marginBottom: "1rem",
            fontSize: "0.88rem",
            lineHeight: 1.45,
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: "1rem", lineHeight: 1 }}>
            {pollResult.kind === "ok"
              ? "✓"
              : pollResult.kind === "error"
                ? "✕"
                : pollResult.kind === "warn"
                  ? "⚠"
                  : "•"}
          </span>
          <span style={{ flex: 1 }}>{pollResult.msg}</span>
          <button
            type="button"
            onClick={() => setPollResult(null)}
            aria-label="Dismiss"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--wp-text-dim)",
              cursor: "pointer",
              fontSize: "0.9rem",
              padding: "0 0.2rem",
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Metric tiles */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          marginBottom: "2rem",
        }}
        data-testid="automation-tiles"
      >
        <Tile label="Classes in window" value={counts.classes_in_window} testid="tile-classes" />
        <Tile label="Artifacts today" value={counts.artifacts_today} testid="tile-artifacts" />
        <Tile
          label="Open exceptions"
          value={counts.open_exceptions}
          testid="tile-exceptions"
          accent={counts.open_exceptions > 0 ? "#c44" : undefined}
        />
      </div>

      {/* Quick links */}
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: "600px" }}>
        <QuickLink
          href={`/automations/${automation.id}/changes`}
          title="Changes"
          subtitle="Mon/Fri-style digest of what added or dropped per class"
          testid="link-changes"
        />
        <QuickLink
          href={`/automations/${automation.id}/exceptions`}
          title="Exceptions"
          subtitle="Parse / match failures awaiting review"
          testid="link-exceptions"
        />
        {automation.has_summary_assembler && (
          <QuickLink
            href={`/automations/${automation.id}/summaries`}
            title="Class summaries"
            subtitle="Coordinator + instructor + survey rollups"
            testid="link-summaries"
          />
        )}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
  testid,
}: {
  label: string;
  value: number;
  accent?: string;
  testid?: string;
}) {
  return (
    <div
      data-testid={testid}
      style={{
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: "8px",
        padding: "1rem 1.25rem",
      }}
    >
      <div style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "2rem",
          fontWeight: 600,
          marginTop: "0.4rem",
          color: accent ?? "var(--wp-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function QuickLink({
  href,
  title,
  subtitle,
  testid,
}: {
  href: string;
  title: string;
  subtitle: string;
  testid?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testid}
      style={{
        display: "block",
        padding: "1rem 1.25rem",
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: "8px",
        textDecoration: "none",
        color: "var(--wp-text)",
      }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "0.2rem" }}>
        {subtitle}
      </div>
    </Link>
  );
}
