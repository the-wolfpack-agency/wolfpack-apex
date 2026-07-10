"use client";

/**
 * ModelRegressionPanel — model-version regression watch for the fleet, surfaced
 * where you manage agents. Reads GET /api/admin/agents/model-regressions and the
 * shared console kit. It answers the founding question the rest of the surface
 * could not: did the newest model make any agent measurably worse at its job?
 *
 * Each standing compares an agent's newest model against the model it used
 * before, holding the agent fixed so the success-rate delta is attributable to
 * the model switch. Regressions are listed worst-first; improvements are counted
 * for context. Read-only summary; the underlying sweep + owner notifications run
 * server-side. Defensive against a malformed body so it never blanks the page
 * around it.
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

type Verdict = "stable" | "regressed" | "improved";

interface Standing {
  agentId: string;
  agentName: string;
  verdict: Verdict;
  candidateModel: string | null;
  baselineModel: string | null;
  candidateSuccessRate: number;
  baselineSuccessRate: number;
  delta: number;
  candidateSamples: number;
  baselineSamples: number;
}
interface RegressionsResponse {
  ok: boolean;
  standings: Standing[];
  regressions: unknown[];
}

const VERDICT_LABEL: Record<Verdict, string> = {
  regressed: "Regressed",
  improved: "Improved",
  stable: "Stable",
};
const VERDICT_TONE: Record<Verdict, SeverityTone> = {
  regressed: "error",
  improved: "success",
  stable: "neutral",
};

type PanelState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; standings: Standing[] };

/** e.g. 0.42 -> "42%". */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
/** Signed percentage-point delta, e.g. -0.18 -> "-18 pts". */
function deltaLabel(delta: number): string {
  const pts = Math.round(delta * 100);
  return `${pts >= 0 ? "+" : ""}${pts} pts`;
}

export function ModelRegressionPanel({
  testId = "model-regression-panel",
}: {
  testId?: string;
}) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/agents/model-regressions");
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as RegressionsResponse;
      // Defensive: a malformed body must never crash the panel and blank the
      // page around it.
      if (!body || !Array.isArray(body.standings)) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "present", standings: body.standings });
    } catch {
      setState({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const standings = state.kind === "present" ? state.standings : [];
  const regressed = standings.filter((s) => s.verdict === "regressed");
  const improved = standings.filter((s) => s.verdict === "improved");

  return (
    <GlassPanel testId={testId} style={{ marginBottom: "1rem" }}>
      <SectionHeader
        title="Model regression watch"
        subtitle="Did the newest model make any agent worse at its task"
      />

      {state.kind === "loading" && (
        <div
          data-testid={`${testId}-loading`}
          style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}
        >
          Evaluating agents across model versions…
        </div>
      )}

      {state.kind === "error" && (
        <div
          data-testid={`${testId}-error`}
          style={{ fontSize: "0.82rem", color: "var(--wp-error, #ef4444)" }}
        >
          Could not load model evals. Reload to retry.
        </div>
      )}

      {state.kind === "present" && (
        <>
          <ConsoleGrid minColWidth={180} testId={`${testId}-metrics`}>
            <MetricTile
              testId={`${testId}-regressed-count`}
              label="Agents regressed"
              value={regressed.length}
              accent={
                regressed.length > 0
                  ? "var(--wp-error, #ef4444)"
                  : "var(--wp-success, #4ade80)"
              }
            />
            <MetricTile
              testId={`${testId}-evaluated-count`}
              label="Agents evaluated"
              value={standings.length}
              accent="var(--wp-text-muted, #9ca3af)"
            />
            <MetricTile
              testId={`${testId}-improved-count`}
              label="Agents improved"
              value={improved.length}
              accent={
                improved.length > 0
                  ? "var(--wp-success, #4ade80)"
                  : "var(--wp-text-muted, #9ca3af)"
              }
            />
          </ConsoleGrid>

          {regressed.length === 0 ? (
            <div
              data-testid={`${testId}-all-clear`}
              style={{
                marginTop: "0.6rem",
                fontSize: "0.85rem",
                color: "var(--wp-success, #4ade80)",
              }}
            >
              {standings.length === 0
                ? "Not enough runs across two model versions to evaluate yet."
                : "No model regressions. Every agent holds its success rate on its newest model."}
            </div>
          ) : (
            <ul
              data-testid={`${testId}-list`}
              style={{
                listStyle: "none",
                margin: "0.7rem 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {regressed.map((s) => (
                <li
                  key={s.agentId}
                  data-testid={`${testId}-agent-${s.agentId}`}
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
                  <StatusPill
                    status={VERDICT_LABEL[s.verdict]}
                    tone={VERDICT_TONE[s.verdict]}
                  />
                  <a
                    href={`/admin/agents/${s.agentId}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: "var(--wp-text, #eee)",
                      textDecoration: "none",
                      fontSize: "0.84rem",
                    }}
                  >
                    {s.agentName}
                    <span
                      style={{
                        color: "var(--wp-text-muted, #9ca3af)",
                        fontSize: "0.74rem",
                      }}
                    >
                      {" "}
                      · {s.baselineModel} ({pct(s.baselineSuccessRate)}) →{" "}
                      {s.candidateModel} ({pct(s.candidateSuccessRate)})
                    </span>
                  </a>
                  <span
                    data-testid={`${testId}-delta-${s.agentId}`}
                    style={{
                      flexShrink: 0,
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      color: "var(--wp-error, #ef4444)",
                    }}
                  >
                    {deltaLabel(s.delta)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </GlassPanel>
  );
}
