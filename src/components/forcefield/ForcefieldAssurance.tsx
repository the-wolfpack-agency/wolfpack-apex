"use client";

/**
 * Forcefield assurance + self-attack panel - the "max confidence" surface. Shows
 * an HONEST per-control protection posture (active / partial / gap) and the live
 * result of driving our own attacks through the real defenses. Collapsed by
 * default; fetches on open. Speaks the shared Forcefield visual language.
 */
import { useCallback, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlowNode } from "@/components/forcefield/intel-visuals";

type Control = { id: string; title: string; status: "active" | "partial" | "gap"; detail: string };
type Scenario = { id: string; attack: string; control: string; defended: boolean; detail: string };
type Breach = { id: string; attack: string; realWorld: string; coverage: "prevented" | "detected" | "out_of_scope"; control: string; detail: string };
type Data = {
  assurance: { controls: Control[]; activeCount: number; partialCount: number; gapCount: number; total: number; score: number };
  adversarial: { results: Scenario[]; defendedCount: number; total: number; allDefended: boolean };
  breaches: { results: Breach[]; prevented: number; detected: number; outOfScope: number; total: number };
};
const COVERAGE_COLOR = { prevented: "#30a46c", detected: "#f5a623", out_of_scope: "#9ca3af" } as const;
const COVERAGE_LABEL = { prevented: "prevented", detected: "detected", out_of_scope: "out of scope" } as const;

const STATUS_COLOR = { active: "#30a46c", partial: "#f5a623", gap: "#ef4444" } as const;

export function ForcefieldAssurance() {
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const load = useCallback(async () => {
    if (data || state === "loading") return;
    setState("loading");
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/assurance");
      if (!res.ok) { setState("error"); return; }
      setData((await res.json()) as Data);
      setState("idle");
    } catch { setState("error"); }
  }, [data, state]);

  const scoreColor = data ? (data.assurance.score >= 80 ? "#30a46c" : data.assurance.score >= 50 ? "#f5a623" : "#ef4444") : "#9ca3af";

  return (
    <details data-testid="forcefield-assurance" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void load(); }} style={{ borderRadius: 12, border: "1px solid var(--wp-dark-border, #262a33)", background: "radial-gradient(120% 150% at 88% 0%, rgba(90,123,208,0.08) 0%, #0b0d11 66%)", overflow: "hidden" }}>
      <summary style={{ cursor: "pointer", listStyle: "none", padding: "0.8rem 1rem", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--wp-text, #e8ebf0)" }}>Assurance &amp; self-test</span>
        {data && (
          <>
            <span data-testid="assurance-score" style={{ fontSize: "0.9rem", fontWeight: 800, color: scoreColor }}>{data.assurance.score}%</span>
            <span style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #9ca3af)" }}>{data.assurance.activeCount} active &middot; {data.assurance.partialCount} partial &middot; {data.assurance.gapCount} gap</span>
            <span data-testid="assurance-selftest" style={{ marginLeft: "auto", fontSize: "0.66rem", fontWeight: 700, color: data.adversarial.allDefended ? "var(--wp-success, #30a46c)" : "var(--wp-error, #ef4444)" }}>
              Self-attack: {data.adversarial.defendedCount}/{data.adversarial.total} defended
            </span>
          </>
        )}
        {!data && <span style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #9ca3af)" }}>open to run</span>}
      </summary>

      <div style={{ padding: "0 1rem 1rem" }}>
        {state === "loading" && <p style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #9ca3af)" }}>Running the self-attack suite&hellip;</p>}
        {state === "error" && <p data-testid="assurance-error" style={{ fontSize: "0.78rem", color: "var(--wp-error, #ef4444)" }}>Could not load the assurance report.</p>}
        {data && (
          <div style={{ display: "grid", gap: "1rem" }}>
            {/* controls */}
            <div>
              <div style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--wp-text-muted, #9ca3af)", marginBottom: "0.5rem" }}>Protection posture (honest: a dark control reads as a gap)</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.35rem" }}>
                {data.assurance.controls.map((c) => (
                  <li key={c.id} data-testid={`assurance-control-${c.id}`} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem" }}>
                    <span style={{ marginTop: "0.2rem" }}><GlowNode color={STATUS_COLOR[c.status]} size={10} pulse={c.status === "gap"} /></span>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>{c.title}</span>
                      <span style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: STATUS_COLOR[c.status], marginLeft: "0.4rem" }}>{c.status}</span>
                      <div style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.4 }}>{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {/* self-attack results */}
            <div>
              <div style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--wp-text-muted, #9ca3af)", marginBottom: "0.5rem" }}>Self-attack: our own agents run these attacks against the live defenses</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.35rem" }}>
                {data.adversarial.results.map((r) => (
                  <li key={r.id} data-testid={`assurance-scenario-${r.id}`} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem" }}>
                    <span style={{ marginTop: "0.15rem", color: r.defended ? "var(--wp-success, #30a46c)" : "var(--wp-error, #ef4444)", fontWeight: 800, fontSize: "0.8rem" }}>{r.defended ? "✓" : "✗"}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "0.76rem", color: "var(--wp-text, #eee)" }}>{r.attack}</div>
                      <div style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #9ca3af)" }}>Stopped by: {r.control} &middot; {r.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {/* known-attack coverage (famous-breach corpus) - honest by design */}
            <div>
              <div style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--wp-text-muted, #9ca3af)", marginBottom: "0.5rem" }}>
                Known-attack coverage &middot; {data.breaches.prevented} prevented &middot; {data.breaches.detected} detected &middot; {data.breaches.outOfScope} honestly out of scope
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.35rem" }}>
                {data.breaches.results.map((b) => (
                  <li key={b.id} data-testid={`assurance-breach-${b.id}`} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem" }}>
                    <span style={{ marginTop: "0.15rem" }}><GlowNode color={COVERAGE_COLOR[b.coverage]} size={10} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "0.76rem", color: "var(--wp-text, #eee)" }}>{b.attack}</span>
                        <span style={{ fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: COVERAGE_COLOR[b.coverage] }}>{COVERAGE_LABEL[b.coverage]}</span>
                      </div>
                      <div style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #9ca3af)" }}>{b.realWorld} &middot; {b.control}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export default ForcefieldAssurance;
