"use client";

/**
 * MsInsightsPanel — surfaces patterns computed from MS365 calendar,
 * email, and tasks data. Sorted risk/warn-first. Each insight fires a
 * `ms_insight.viewed` event once on first render so the learning loop
 * knows which patterns actually get seen.
 */

import { useEffect, useRef, useState } from "react";
import { fetchWithRefresh, authHeaders, jsonHeaders } from "@/lib/client-auth";

type Severity = "ok" | "info" | "warn" | "risk";

interface Insight {
  id: string;
  kind: "calendar" | "tasks" | "email" | "mixed";
  severity: Severity;
  headline: string;
  detail: string;
  metric: number | null;
  cta?: { label: string; href: string };
}

function fireAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

const SEV_STYLE: Record<Severity, { bg: string; color: string; label: string }> = {
  risk: { bg: "rgba(239, 68, 68, 0.15)", color: "var(--wp-error)", label: "Risk" },
  warn: { bg: "rgba(234, 179, 8, 0.15)", color: "var(--wp-warning)", label: "Watch" },
  info: { bg: "rgba(107, 114, 128, 0.15)", color: "var(--wp-text-dim)", label: "Info" },
  ok: { bg: "rgba(34, 197, 94, 0.15)", color: "var(--wp-success)", label: "OK" },
};

export default function MsInsightsPanel() {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const viewedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/ms/insights", { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setError("restricted");
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError("Unable to load insights");
          setLoading(false);
          return;
        }
        const body = (await res.json()) as { insights: Insight[] };
        const list = Array.isArray(body.insights) ? body.insights : [];
        setInsights(list);
        setLoading(false);
        for (const i of list) {
          if (viewedIds.current.has(i.id)) continue;
          viewedIds.current.add(i.id);
          fireAnalytics("ms_insight.viewed", {
            insight_id: i.id,
            severity: i.severity,
            kind: i.kind,
          });
        }
      } catch {
        if (!cancelled) {
          setError("Unable to load insights");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error === "restricted") return null;

  if (loading) {
    return (
      <div
        data-testid="ms-insights-panel-loading"
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Loading insights…
        </p>
      </div>
    );
  }

  if (error || !insights) {
    return (
      <div
        data-testid="ms-insights-panel-error"
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--wp-warning)" }}>
          {error ?? "Unable to load insights"}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="ms-insights-panel"
      className="rounded-lg p-5 border space-y-3"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <h2 className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
        MS 365 Insights
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {insights.map((i) => {
          const sev = SEV_STYLE[i.severity];
          return (
            <div
              key={i.id}
              data-testid={`insight-${i.id}`}
              className="rounded-lg p-3 border"
              style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-full"
                  style={{ background: sev.bg, color: sev.color }}
                >
                  {sev.label}
                </span>
                <span className="text-xs uppercase" style={{ color: "var(--wp-text-muted)" }}>
                  {i.kind}
                </span>
              </div>
              <p className="text-sm font-medium mt-2" style={{ color: "var(--wp-text)" }}>
                {i.headline}
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>
                {i.detail}
              </p>
              {i.cta && (
                <a
                  href={i.cta.href}
                  className="inline-block mt-2 text-xs font-medium"
                  style={{ color: "var(--wp-gold)" }}
                  onClick={() =>
                    fireAnalytics("ms_insight.cta_clicked", {
                      insight_id: i.id,
                      href: i.cta!.href,
                    })
                  }
                >
                  {i.cta.label} →
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
