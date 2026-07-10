"use client";

/**
 * ReleaseGatePanel — the Production Release Gate, surfaced where you manage
 * agents. Reuses the SAME data source as /admin/deployment
 * (GET /api/admin/deployment/release-gate) and the shared console kit, so this
 * is a read-focused summary: it shows what is blocking a prod deploy (per PR:
 * state, author, age) and links to the full gate for the one-click promote.
 * This is the first step of the deployment control plane: see and act on
 * deployment activity from inside the agents surface.
 *
 * Honest-degrade aware: when GitHub could not be reached the gate returns a
 * `degraded` field, which we surface as "could not check" instead of a false
 * all-clear.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  ConsoleGrid,
  SectionHeader,
  type SeverityTone,
} from "@/components/console";

type ReleaseBlockState =
  | "awaiting_approval"
  | "checks_running"
  | "checks_failing"
  | "merge_conflict"
  | "ready_to_merge";

interface BlockingChange {
  number: number;
  title: string;
  url: string;
  author: string;
  state: ReleaseBlockState;
  reason: string;
  ageHours: number;
}
interface Gate {
  productionBranch: string;
  blocking: BlockingChange[];
  checkedAt: string;
  degraded?: { detail: string } | null;
}
interface GateResponse {
  ok: boolean;
  gate: Gate;
}

const STATE_LABEL: Record<ReleaseBlockState, string> = {
  ready_to_merge: "Ready to promote",
  awaiting_approval: "Awaiting approval",
  checks_running: "Checks running",
  checks_failing: "Checks failing",
  merge_conflict: "Merge conflict",
};
const STATE_TONE: Record<ReleaseBlockState, SeverityTone> = {
  ready_to_merge: "success",
  awaiting_approval: "warning",
  checks_running: "info",
  checks_failing: "error",
  merge_conflict: "error",
};

type PanelState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; gate: Gate };

function ageLabel(hours: number): string {
  if (hours < 1) return "under 1h";
  return `${Math.round(hours)}h`;
}

export function ReleaseGatePanel({ testId = "release-gate-panel" }: { testId?: string }) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/deployment/release-gate");
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as GateResponse;
      // Defensive: a malformed / unexpected body must never crash the panel and
      // blank the page around it. Treat anything without a valid gate as an
      // error the user can retry from the full gate.
      const gate = body?.gate;
      if (!gate || !Array.isArray(gate.blocking)) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "present", gate });
    } catch {
      setState({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const blocking = state.kind === "present" ? state.gate.blocking : [];
  const readyCount = blocking.filter((c) => c.state === "ready_to_merge").length;
  const degraded = state.kind === "present" ? state.gate.degraded : null;

  return (
    <GlassPanel testId={testId} style={{ marginBottom: "1rem" }}>
      <SectionHeader
        title="Production release gate"
        subtitle="What is blocking a production deploy right now"
        actions={
          <a
            href="/admin/deployment"
            data-testid={`${testId}-open-full`}
            style={{ fontSize: "0.78rem", color: "var(--wp-gold, #e8b528)", textDecoration: "none" }}
          >
            Open the full gate and promote →
          </a>
        }
      />

      {state.kind === "loading" && (
        <div data-testid={`${testId}-loading`} style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>
          Checking the release gate…
        </div>
      )}

      {state.kind === "error" && (
        <div data-testid={`${testId}-error`} style={{ fontSize: "0.82rem", color: "var(--wp-error, #ef4444)" }}>
          Could not load the release gate. Open the full gate to retry.
        </div>
      )}

      {state.kind === "present" && (
        <>
          {degraded ? (
            <div
              data-testid={`${testId}-degraded`}
              style={{
                fontSize: "0.8rem",
                color: "var(--wp-warning, #f59e0b)",
                padding: "0.5rem 0.7rem",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: "6px",
              }}
            >
              Could not check GitHub: {degraded.detail}. This is not a clear-to-deploy.
            </div>
          ) : (
            <>
              <ConsoleGrid minColWidth={180} testId={`${testId}-metrics`}>
                <MetricTile
                  testId={`${testId}-blocking-count`}
                  label="Blocking production"
                  value={blocking.length}
                  accent={blocking.length > 0 ? "var(--wp-warning, #f59e0b)" : "var(--wp-success, #4ade80)"}
                />
                <MetricTile
                  testId={`${testId}-ready-count`}
                  label="Ready to promote"
                  value={readyCount}
                  accent={readyCount > 0 ? "var(--wp-success, #4ade80)" : "var(--wp-text-muted, #9ca3af)"}
                />
              </ConsoleGrid>

              {blocking.length === 0 ? (
                <div
                  data-testid={`${testId}-all-clear`}
                  style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--wp-success, #4ade80)" }}
                >
                  Nothing is blocking production. Clear to deploy.
                </div>
              ) : (
                <ul
                  data-testid={`${testId}-list`}
                  style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}
                >
                  {blocking.map((c) => (
                    <li
                      key={c.number}
                      data-testid={`${testId}-pr-${c.number}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.6rem",
                        padding: "0.5rem 0.6rem",
                        borderRadius: "6px",
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      <StatusPill status={STATE_LABEL[c.state]} tone={STATE_TONE[c.state]} />
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ flex: 1, minWidth: 0, color: "var(--wp-text, #eee)", textDecoration: "none", fontSize: "0.84rem" }}
                      >
                        #{c.number} {c.title}
                      </a>
                      <span style={{ flexShrink: 0, fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                        {c.author} · blocking {ageLabel(c.ageHours)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </GlassPanel>
  );
}
