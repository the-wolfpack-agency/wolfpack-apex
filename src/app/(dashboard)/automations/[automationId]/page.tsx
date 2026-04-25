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
  const [pollResult, setPollResult] = useState<string | null>(null);

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
    setPollResult(null);
    try {
      const r = await fetchWithRefresh(
        `/api/automations/${automationId}/poll`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) {
        setPollResult(`Failed: ${data.error ?? r.status}`);
      } else {
        const res = data.result;
        setPollResult(
          `Polled · matched ${res.messages_matched} · ingested ` +
            `${res.artifacts_ingested} · duplicates ${res.artifacts_duplicate} ` +
            `· quarantined ${res.artifacts_quarantined}`,
        );
        await load();
      }
    } catch (err) {
      setPollResult(`Network error: ${(err as Error).message}`);
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
          style={{
            background: polling ? "var(--wp-border)" : "var(--wp-gold)",
            color: polling ? "var(--wp-text-dim)" : "var(--wp-dark)",
            border: "none",
            padding: "0.6rem 1.2rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: polling ? "not-allowed" : "pointer",
          }}
        >
          {polling ? "Polling…" : "Run now"}
        </button>
      </div>

      {pollResult && (
        <div
          data-testid="automation-poll-result"
          style={{
            padding: "0.6rem 0.8rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            color: "var(--wp-text-dim)",
            marginBottom: "1rem",
            fontSize: "0.85rem",
          }}
        >
          {pollResult}
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
