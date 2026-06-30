"use client";

/**
 * /admin/compliance: compliance evidence (demo beat "Comply").
 *
 * Generate a framework coverage report from LIVE OGIAM controls (audit chain,
 * gate decisions, red-team pass rate, the ungoverned-AI gap). Each control's
 * covered/partial/gap status is derived from measured evidence, never asserted,
 * so the report is honest and auditable. The screen that turns governance from a
 * binder into a signed receipt.
 *
 * GET /api/admin/compliance/report for history; POST { framework } to generate.
 * Every fetch goes through fetchWithRefresh; the (dashboard) layout enforces auth.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  ConsoleGrid,
  GlassPanel,
  MetricTile,
  SectionHeader,
  StatusPill,
  TONE_VAR,
} from "@/components/console";

type Framework = "SOC2" | "ISO42001" | "NIST_AI_RMF" | "EU_AI_ACT";

const FRAMEWORKS: { id: Framework; label: string }[] = [
  { id: "SOC2", label: "SOC 2" },
  { id: "ISO42001", label: "ISO 42001" },
  { id: "NIST_AI_RMF", label: "NIST AI RMF" },
  { id: "EU_AI_ACT", label: "EU AI Act" },
];

interface ControlResult {
  id: string;
  name: string;
  ogiamControl: string;
  rationale: string;
  status: "covered" | "partial" | "gap";
  evidence: string;
}

interface Report {
  framework: Framework;
  controls: ControlResult[];
  covered: number;
  partial: number;
  gap: number;
  coverage: number;
}

interface ReportRecord {
  id: string;
  framework: string;
  coverage: number;
  covered: number;
  partial: number;
  gap: number;
  createdAt: string;
}

const STATUS_TONE = { covered: "success", partial: "warning", gap: "error" } as const;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function CompliancePage() {
  const [framework, setFramework] = useState<Framework>("SOC2");
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<ReportRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [generating, setGenerating] = useState(false);

  const loadHistory = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetchWithRefresh("/api/admin/compliance/report");
      if (!res.ok) throw new Error(`status ${res.status}`);
      setHistory((await res.json()).reports ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetchWithRefresh("/api/admin/compliance/report", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ framework }),
      });
      if (res.ok) {
        setReport((await res.json()).report as Report);
        await loadHistory();
      }
    } finally {
      setGenerating(false);
    }
  }, [framework, loadHistory]);

  return (
    <div data-testid="compliance-root" className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
      <SectionHeader
        eyebrow="Compliance"
        title="Compliance Evidence"
        subtitle="Coverage against the major frameworks, generated from live controls, not a binder."
        actions={
          <div className="flex items-center gap-3">
            <select
              aria-label="Framework"
              value={framework}
              onChange={(e) => setFramework(e.target.value as Framework)}
              className="rounded-md border border-hairline bg-transparent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted"
            >
              {FRAMEWORKS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={generating}
              data-testid="compliance-generate"
              className="rounded-md border border-hairline px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              {generating ? "Generating…" : "Generate report"}
            </button>
          </div>
        }
      />

      {state === "error" && (
        <p data-testid="compliance-error" className="mt-8 text-sm text-muted">
          Could not load compliance history. Retry, or check that your session is active.
        </p>
      )}

      {report && (
        <>
          <ConsoleGrid testId="compliance-summary" className="mt-8">
            <MetricTile
              label={`${FRAMEWORKS.find((f) => f.id === report.framework)?.label ?? report.framework} coverage`}
              display={pct(report.coverage)}
              accent={report.coverage >= 0.75 ? TONE_VAR.success : TONE_VAR.warning}
            />
            <MetricTile label="Covered" value={report.covered} accent={TONE_VAR.success} />
            <MetricTile label="Partial" value={report.partial} accent={report.partial > 0 ? TONE_VAR.warning : undefined} />
            <MetricTile label="Gaps" value={report.gap} accent={report.gap > 0 ? TONE_VAR.error : undefined} />
          </ConsoleGrid>

          <GlassPanel className="mt-8" title="Controls" subtitle="Status derived from measured OGIAM evidence">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="py-2 pr-4">Control</th>
                    <th className="py-2 pr-4">OGIAM control</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {report.controls.map((c) => (
                    <tr key={c.id} data-testid="compliance-control-row" className="border-t border-hairline">
                      <td className="py-2.5 pr-4 text-ink-soft">{c.id} {c.name}</td>
                      <td className="py-2.5 pr-4 text-ink-soft">{c.ogiamControl}</td>
                      <td className="py-2.5 pr-4">
                        <StatusPill status={c.status} tone={STATUS_TONE[c.status]} />
                      </td>
                      <td className="py-2.5 pr-4 text-[12px] text-muted">{c.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassPanel>
        </>
      )}

      <GlassPanel className="mt-8" title="Report history" subtitle={state === "loading" ? "Loading…" : `${history.length} report(s)`}>
        {state === "ready" && history.length === 0 ? (
          <p data-testid="compliance-empty" className="py-6 text-sm text-muted">
            No reports yet. Pick a framework and generate one to see your coverage.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                <tr>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Framework</th>
                  <th className="py-2 pr-4">Coverage</th>
                  <th className="py-2 pr-4">Gaps</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} data-testid="compliance-history-row" className="border-t border-hairline">
                    <td className="py-2.5 pr-4 font-mono text-[12px] text-muted">{r.createdAt}</td>
                    <td className="py-2.5 pr-4 text-ink-soft">{r.framework}</td>
                    <td className="py-2.5 pr-4 text-ink-soft">{pct(r.coverage)}</td>
                    <td className="py-2.5 pr-4">
                      <StatusPill status={r.gap === 0 ? "clean" : "gap"} tone={r.gap === 0 ? "success" : "error"} label={String(r.gap)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
