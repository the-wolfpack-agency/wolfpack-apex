"use client";

/**
 * /admin/demo - one-click demo reset.
 *
 * The operator's pre-demo button: restore a known-good, populated governance
 * state across all five demo beats so the live walkthrough always lands. One
 * POST seeds everything through the real domain path (gate -> ledger, inventory,
 * red-team, compliance) and reports what it produced, beat by beat, with deep
 * links into each surface so the operator can click straight into the demo.
 *
 * POST /api/admin/ogiam/demo-reset -> { result }. Every fetch via
 * fetchWithRefresh; the (dashboard) layout enforces auth.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  ConsoleGrid,
  GlassPanel,
  MetricTile,
  SectionHeader,
  StatusPill,
  TONE_VAR,
} from "@/components/console";

interface DemoSeedResult {
  target: string;
  surfaces: { found: number; written: number; ungoverned: number };
  decisions: { recorded: number; flagged: number; wouldBlock: number };
  enforcement: { capability: string; mode: "monitor" | "enforce" }[];
  redteam: { attacks: number; blocked: number; vulns: number; passRate: number };
  compliance: { framework: string; coverage: number; gap: number }[];
}

const BEATS: { href: string; label: string; desc: string }[] = [
  { href: "/admin/ai-surfaces", label: "Discover", desc: "AI surface inventory" },
  { href: "/admin/ogiam", label: "Govern", desc: "Gate decisions + enforcement" },
  { href: "/admin/ai-redteam", label: "Assure", desc: "Continuous red-team" },
  { href: "/admin/compliance", label: "Comply", desc: "Framework coverage" },
];

export default function DemoResetPage() {
  const [result, setResult] = useState<DemoSeedResult | null>(null);
  const [state, setState] = useState<"idle" | "seeding" | "error">("idle");

  const reset = useCallback(async () => {
    setState("seeding");
    try {
      const res = await fetchWithRefresh("/api/admin/ogiam/demo-reset", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setResult((await res.json()).result as DemoSeedResult);
      setState("idle");
    } catch {
      setState("error");
    }
  }, []);

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div data-testid="demo-reset-root" className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
      <SectionHeader
        eyebrow="Demo"
        title="Demo Reset"
        subtitle="Restore a known-good, populated governance state across all five demo beats. Seeded through the real gate, ledger, red-team, and compliance path, never injected."
        actions={
          <button
            type="button"
            onClick={() => void reset()}
            disabled={state === "seeding"}
            data-testid="demo-reset-run"
            className="rounded-md border border-hairline px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            {state === "seeding" ? "Seeding…" : "Reset demo data"}
          </button>
        }
      />

      {state === "error" && (
        <p data-testid="demo-reset-error" className="mt-8 text-sm text-muted">
          Demo seed failed. Retry, or check that your session is active and you have admin access.
        </p>
      )}

      {!result && state !== "error" && (
        <GlassPanel className="mt-8" title="Before you present" subtitle="One click populates every beat">
          <p data-testid="demo-reset-empty" className="py-2 text-sm text-muted">
            Click <span className="text-ink-soft">Reset demo data</span> to seed AI surfaces, a spread of
            gate decisions, enforcement postures, a red-team run, and compliance reports. Then walk the
            beats below.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {BEATS.map((b) => (
              <Link key={b.href} href={b.href} className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink">
                {b.label} <span className="text-ink-soft">{b.desc}</span>
              </Link>
            ))}
          </div>
        </GlassPanel>
      )}

      {result && (
        <>
          <ConsoleGrid testId="demo-reset-summary" className="mt-8">
            <MetricTile label="AI surfaces" value={result.surfaces.found} accent={TONE_VAR.info} />
            <MetricTile label="Ungoverned" value={result.surfaces.ungoverned} accent={result.surfaces.ungoverned > 0 ? TONE_VAR.warning : undefined} />
            <MetricTile label="Gate decisions" value={result.decisions.recorded} accent={TONE_VAR.success} />
            <MetricTile label="Would block" value={result.decisions.wouldBlock} accent={result.decisions.wouldBlock > 0 ? TONE_VAR.error : undefined} />
            <MetricTile label="Red-team pass" display={pct(result.redteam.passRate)} accent={result.redteam.vulns === 0 ? TONE_VAR.success : TONE_VAR.error} />
            <MetricTile label="Compliance reports" value={result.compliance.length} accent={TONE_VAR.info} />
          </ConsoleGrid>

          <GlassPanel className="mt-8" title="Walk the beats" subtitle={`Seeded target: ${result.target}`}>
            <div className="flex flex-wrap gap-3">
              {BEATS.map((b) => (
                <Link key={b.href} href={b.href} data-testid="demo-reset-beat-link" className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink">
                  {b.label} <span className="text-ink-soft">{b.desc}</span>
                </Link>
              ))}
            </div>
          </GlassPanel>

          <GlassPanel className="mt-8" title="Enforcement postures seeded" subtitle="The monitor / enforce control knob">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                  <tr>
                    <th className="py-2 pr-4">Capability</th>
                    <th className="py-2 pr-4">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {result.enforcement.map((e) => (
                    <tr key={e.capability} data-testid="demo-reset-policy-row" className="border-t border-hairline">
                      <td className="py-2.5 pr-4 text-ink-soft">{e.capability}</td>
                      <td className="py-2.5 pr-4">
                        <StatusPill status={e.mode} tone={e.mode === "enforce" ? "success" : "info"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassPanel>
        </>
      )}
    </div>
  );
}
