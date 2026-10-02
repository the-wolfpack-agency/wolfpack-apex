"use client";

/**
 * Multi-model benchmark panel - runs the SAME battery across every available
 * model and shows the per-model grades side by side.
 *
 * WHY CLIENT-DRIVEN: one benchmark is N prompts x M models pipeline runs, each a
 * ~15-30s real authoring+gate pass. Driving that synchronously from one server
 * request would blow the serverless function timeout, so the browser loops the
 * EXISTING pipeline endpoint (pinned per model) - the real, UI-equivalent path -
 * and grades the results with the shared gradeRuns. No new server orchestration,
 * natural per-user auth via fetchWithRefresh.
 *
 * Reuse: the pipeline endpoint, the benchmark/models endpoint (available models),
 * and gradeRuns (the one grader) - not a second metrics implementation.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, StatusPill } from "@/components/console";
import { gradeRuns, type PipelineRunRecord, type ModelGrade } from "@/lib/ai-code/grading";

interface BenchModel {
  pin: string;
  provider: string;
  tier: string;
  label: string;
}

/** A small, representative battery: clean authoring tasks that measure a model's
 *  quality (readyRate / first-pass) and cost, bounded so a run stays a couple of
 *  minutes. */
const BATTERY: readonly string[] = [
  "Add a pure clamp(n, lo, hi) helper in src/lib/clamp.ts that returns n bounded to [lo, hi], with a test file.",
  "Add a pure slugify(input: string) helper in src/lib/slugify.ts that lowercases and hyphenates, with a test file.",
];

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export default function BenchmarkPanel() {
  const [models, setModels] = useState<BenchModel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [grades, setGrades] = useState<ModelGrade[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithRefresh("/api/admin/ai-code/benchmark/models");
        if (!res.ok) {
          setLoadError(`Could not load models (${res.status}).`);
          return;
        }
        const body = (await res.json()) as { models?: BenchModel[] };
        setModels(body.models ?? []);
      } catch {
        setLoadError("Could not load models.");
      }
    })();
  }, []);

  /** Drive one (model, prompt) through the real pipeline; map it to a run record. */
  const runOne = useCallback(async (model: BenchModel, prompt: string): Promise<PipelineRunRecord | null> => {
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/pipeline", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ ref: `bench-${model.pin}`, prompt, executorProviderPin: model.pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.run) return null;
      return {
        model: model.label,
        status: body.run.status,
        attempts: body.run.remediation?.attempts?.length ?? 0,
        finalOutcome: body.run.review?.verdict?.outcome ?? "allow",
        deepScanCritical: body.deepScan?.critical ?? 0,
        selfHealed: body.selfHealed ?? false,
        costUsd: body.cost?.actualUsd ?? 0,
      };
    } catch {
      return null;
    }
  }, []);

  const runBenchmark = useCallback(async () => {
    if (running || models.length === 0) return;
    setRunning(true);
    setGrades(null);
    const total = models.length * BATTERY.length;
    setProgress({ done: 0, total });
    const records: PipelineRunRecord[] = [];
    let done = 0;
    for (const model of models) {
      for (const prompt of BATTERY) {
        const rec = await runOne(model, prompt);
        if (rec) records.push(rec);
        done++;
        setProgress({ done, total });
      }
    }
    // Reuse the ONE grader; sort best-usable first (readyRate, then first-pass).
    const grade = gradeRuns(records);
    const ranked = [...grade.byModel].sort(
      (a, b) => b.readyRate - a.readyRate || b.firstPassRate - a.firstPassRate,
    );
    setGrades(ranked);
    setRunning(false);
    setProgress(null);
  }, [models, running, runOne]);

  return (
    <GlassPanel
      title="Model benchmark"
      subtitle="Run the same battery across every available model and compare them side by side"
    >
      <div data-testid="benchmark-panel" style={{ display: "grid", gap: "0.85rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          {models.length === 0 && !loadError && <span style={{ color: "var(--wp-text-dim)" }}>Loading available models…</span>}
          {loadError && <span style={{ color: "var(--wp-error, #ef4444)" }}>{loadError}</span>}
          {models.map((m) => (
            <StatusPill key={m.pin} status={m.provider} tone="neutral" label={`${m.label} (${m.tier})`} size="sm" />
          ))}
        </div>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button
            type="button"
            data-testid="run-benchmark"
            onClick={() => void runBenchmark()}
            disabled={running || models.length === 0}
            style={{
              padding: "0.5rem 0.9rem",
              borderRadius: "0.5rem",
              border: "1px solid var(--wp-border, #2a2f3a)",
              background: running ? "var(--wp-surface-2, #1a1f29)" : "var(--wp-gold, #e8b528)",
              color: running ? "var(--wp-text-dim)" : "#111",
              fontWeight: 600,
              cursor: running || models.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {running ? "Running…" : `Run benchmark (${models.length} models × ${BATTERY.length} prompts)`}
          </button>
          {progress && (
            <span data-testid="benchmark-progress" style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
              {progress.done}/{progress.total} runs
            </span>
          )}
        </div>

        {grades && grades.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table data-testid="benchmark-results" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--wp-text-dim)" }}>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Model</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Runs</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Ready</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>First-pass</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Recovery</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Avg cost</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g, i) => (
                  <tr key={g.model} style={{ borderTop: "1px solid var(--wp-border, #2a2f3a)", fontVariantNumeric: "tabular-nums" }}>
                    <td style={{ padding: "0.4rem 0.6rem", fontWeight: i === 0 ? 700 : 400 }}>
                      {i === 0 ? "★ " : ""}{g.model}
                    </td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{g.n}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{pct(g.readyRate)}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{pct(g.firstPassRate)}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{pct(g.recoveryRate)}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{g.pricedShare > 0 ? usd(g.avgCostUsd) : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: "0.5rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.78rem" }}>
              ★ best readyRate. Cost is per priced run; &quot;n/a&quot; means the model is unpriced (not free).
            </p>
          </div>
        )}
        {grades && grades.length === 0 && (
          <p data-testid="benchmark-empty" style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
            No runs completed - every model returned no usable result.
          </p>
        )}
      </div>
    </GlassPanel>
  );
}
