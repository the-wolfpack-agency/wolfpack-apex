"use client";

/**
 * /automations — top-level index of registered automations.
 *
 * One row per automation registered in `lib/automations/registry.ts`.
 * Click a row → `/automations/[id]`. The metadata projection here is
 * intentionally light (no parsers / assemblers leak to the client).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface AutomationMetadata {
  id: string;
  name: string;
  owner_label: string;
  description: string;
  active_window_days: { min: number; max: number };
  source_types: string[];
  has_summary_assembler: boolean;
}

export default function AutomationsIndexPage() {
  const [automations, setAutomations] = useState<AutomationMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetchWithRefresh("/api/automations");
        if (!r.ok) {
          setError(`Failed to load automations (${r.status})`);
          setLoading(false);
          return;
        }
        const data = (await r.json()) as { automations: AutomationMetadata[] };
        setAutomations(data.automations ?? []);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Automations</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          Codified recurring workflows. Each automation watches an inbox,
          parses inbound artifacts, surfaces deltas, and queues anything
          ambiguous for human review.
        </p>
      </div>

      {loading && <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>}
      {error && <div style={{ color: "#c44" }}>{error}</div>}

      {!loading && !error && automations.length === 0 && (
        <div
          style={{
            padding: "3rem",
            textAlign: "center",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
          }}
        >
          No automations registered yet.
        </div>
      )}

      {!loading && automations.length > 0 && (
        <div
          style={{ display: "grid", gap: "0.75rem" }}
          data-testid="automations-list"
        >
          {automations.map((a) => (
            <Link
              key={a.id}
              href={`/automations/${a.id}`}
              data-testid={`automation-row-${a.id}`}
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>
                    {a.name}
                  </div>
                  <div
                    style={{
                      color: "var(--wp-text-dim)",
                      fontSize: "0.85rem",
                      marginTop: "0.3rem",
                      lineHeight: 1.4,
                    }}
                  >
                    {a.description}
                  </div>
                  <div
                    style={{
                      color: "var(--wp-text-dim)",
                      fontSize: "0.75rem",
                      marginTop: "0.6rem",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Window: {a.active_window_days.min}d →{" "}
                    {a.active_window_days.max}d · Sources:{" "}
                    {a.source_types.length}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
