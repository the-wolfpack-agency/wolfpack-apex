"use client";

/**
 * /admin/ai-redteam: continuous AI red-team assurance (demo beat "Assure").
 *
 * The standing proof that the gate holds: an adversarial corpus is run against
 * the real OGIAM gate and the result is shown. Healthy = 100% blocked, 0 vulns.
 * A vuln means a policy regression let an attack through. The headline screen for
 * "we don't ask you to trust it, we prove it, on a schedule."
 *
 * GET /api/admin/ai-redteam/run for the history; POST to run on demand. Every
 * fetch goes through fetchWithRefresh; the (dashboard) layout enforces auth.
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

interface RunRecord {
  id: string;
  attacksRun: number;
  blocked: number;
  vulns: number;
  passRate: number;
  risk: string;
  source: string;
  createdAt: string;
}

interface Finding {
  attackId: string;
  category: string;
  technique: string;
  outcome: string;
  ruleId: string;
}

interface Report {
  attacksRun: number;
  blocked: number;
  vulns: Finding[];
  passRate: number;
  byCategory: Record<string, { run: number; blocked: number }>;
}

const CATEGORY_LABEL: Record<string, string> = {
  LLM01_prompt_injection: "Prompt injection",
  LLM06_info_disclosure: "Info disclosure",
  LLM07_insecure_tool: "Insecure tool",
  LLM08_excessive_agency: "Excessive agency",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function AiRedteamPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);

  const loadHistory = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetchWithRefresh("/api/admin/ai-redteam/run");
      if (!res.ok) throw new Error(`status ${res.status}`);
      setRuns((await res.json()).runs ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-redteam/run", { method: "POST", headers: jsonHeaders() });
      if (res.ok) {
        setReport((await res.json()).report as Report);
        await loadHistory();
      }
    } finally {
      setRunning(false);
    }
  }, [loadHistory]);

  const latestPass = report ? report.passRate : runs[0]?.passRate ?? null;
  const latestVulns = report ? report.vulns.length : runs[0]?.vulns ?? null;
  const healthy = latestVulns === 0;

  return (
    <div data-testid="ai-redteam-root" className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
      <SectionHeader
        eyebrow="Continuous Assurance"
        title="AI Red-Team"
        subtitle="We attack your own gate with the known AI attack classes and prove it holds."
        actions={
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={running}
            data-testid="ai-redteam-run"
            className="rounded-md border border-hairline px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            {running ? "Running…" : "Run red-team now"}
          </button>
        }
      />

      {state === "error" && (
        <p data-testid="ai-redteam-error" className="mt-8 text-sm text-muted">
          Could not load red-team history. Retry, or check that your session is active.
        </p>
      )}

      {state !== "error" && (
        <>
          <ConsoleGrid testId="ai-redteam-summary" className="mt-8">
            <MetricTile
              label="Pass rate"
              display={latestPass === null ? "—" : pct(latestPass)}
              accent={latestPass === 1 ? TONE_VAR.success : latestPass !== null ? TONE_VAR.warning : undefined}
            />
            <MetricTile
              label="Vulnerabilities"
              value={latestVulns ?? 0}
              accent={!healthy && latestVulns !== null ? TONE_VAR.error : undefined}
            />
            <MetricTile label="Attacks" value={report?.attacksRun ?? runs[0]?.attacksRun ?? 0} />
            <MetricTile label="Runs recorded" value={runs.length} />
          </ConsoleGrid>

          {report && (
            <GlassPanel className="mt-8" title="By attack category" subtitle="This run, blocked of run">
              <div className="flex flex-wrap gap-3">
                {Object.entries(report.byCategory).map(([cat, c]) => (
                  <div key={cat} data-testid="ai-redteam-category" className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2">
                    <StatusPill status={c.blocked === c.run ? "blocked" : "warning"} label={`${c.blocked}/${c.run}`} tone={c.blocked === c.run ? "success" : "warning"} />
                    <span className="text-sm text-ink-soft">{CATEGORY_LABEL[cat] ?? cat}</span>
                  </div>
                ))}
              </div>
              {report.vulns.length > 0 && (
                <div data-testid="ai-redteam-vulns" className="mt-4 text-sm" style={{ color: TONE_VAR.error }}>
                  {report.vulns.length} attack(s) got through: {report.vulns.map((v) => v.attackId).join(", ")}
                </div>
              )}
            </GlassPanel>
          )}

          <GlassPanel className="mt-8" title="Run history" subtitle={state === "loading" ? "Loading…" : `${runs.length} run(s)`}>
            {state === "ready" && runs.length === 0 ? (
              <p data-testid="ai-redteam-empty" className="py-6 text-sm text-muted">
                No red-team runs yet. Run one now, or the scheduled sweep will populate this.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                    <tr>
                      <th className="py-2 pr-4">When</th>
                      <th className="py-2 pr-4">Pass</th>
                      <th className="py-2 pr-4">Blocked</th>
                      <th className="py-2 pr-4">Vulns</th>
                      <th className="py-2 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} data-testid="ai-redteam-row" className="border-t border-hairline">
                        <td className="py-2.5 pr-4 font-mono text-[12px] text-muted">{r.createdAt}</td>
                        <td className="py-2.5 pr-4 text-ink-soft">{pct(r.passRate)}</td>
                        <td className="py-2.5 pr-4 text-ink-soft">{r.blocked}/{r.attacksRun}</td>
                        <td className="py-2.5 pr-4 text-ink-soft">{r.vulns}</td>
                        <td className="py-2.5 pr-4">
                          <StatusPill status={r.risk} tone={r.vulns === 0 ? "success" : "error"} label={r.vulns === 0 ? "clean" : "regression"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}
