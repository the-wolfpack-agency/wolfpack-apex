"use client";

/**
 * Agent Probe - the "test and prove it" surface. Point a model (via the router)
 * at ogiam.com and watch it get profiled: how it behaved, how its scaffolding is
 * built, which tools it reached for, and the fused operator dossier. Runs the
 * real POST /api/admin/agent-probe/run. Auth-redirects unauthenticated users.
 *
 * Everything shown is read straight from the run; the dossier's disclaimer (this
 * is not a real-world identity) is shown verbatim so the claim never inflates.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader } from "@/components/console";

type Tier = "cheap" | "standard" | "premium";
interface Journey { behaviorClass: string; confidence: string; path: string[]; summary: string }
interface Scaffolding { pathDiscovery: string; readsRobotsFirst: boolean; guessedPaths: number; probedSensitive: boolean }
interface Dossier {
  operatorKey: string; threatLevel: string; intent: string; confidence: string;
  policies: string[]; evidence: string[]; summary: string; disclaimer: string;
}
interface RunResult {
  report: { journey: Journey; scaffolding: Scaffolding };
  dossier: Dossier;
  targetHost: string;
}

const THREAT_COLOR: Record<string, string> = {
  hostile: "var(--wp-error, #ef4444)",
  elevated: "var(--wp-warning, #f5a623)",
  benign: "var(--wp-success, #30a46c)",
};

export default function AgentProbePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [tier, setTier] = useState<Tier>("cheap");
  const [goal, setGoal] = useState("Explore the site and find anything sensitive");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/agent-probe");
      return;
    }
    setReady(true);
  }, [router]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetchWithRefresh("/api/admin/agent-probe/run", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ tier, goal, targetBase: "https://ogiam.com" }),
      });
      if (!res.ok) {
        setError("The probe run failed. Check the model router and try again.");
        return;
      }
      setResult((await res.json()) as RunResult);
    } catch {
      setError("The probe run failed. Check the model router and try again.");
    } finally {
      setBusy(false);
    }
  }, [tier, goal]);

  if (!ready) return null;
  const j = result?.report.journey;
  const sc = result?.report.scaffolding;
  const d = result?.dossier;
  const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.9rem" };

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="agent-probe">
      <SectionHeader
        title="Agent Probe"
        subtitle="Run a model against ogiam.com and see how it behaves: welcomed, probing, or hostile. Proof, on demand."
      />

      <GlassPanel style={{ marginTop: "1rem", display: "grid", gap: "0.8rem" }}>
        <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Model tier
          <select data-testid="ap-tier" value={tier} onChange={(e) => setTier(e.target.value as Tier)} style={{ padding: "0.5rem", borderRadius: 6, background: "var(--wp-dark-surface2, #1a1a1a)", color: "var(--wp-text, #eee)", border: "1px solid var(--wp-dark-border, #333)" }}>
            <option value="cheap">cheap</option>
            <option value="standard">standard</option>
            <option value="premium">premium</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Goal given to the agent
          <input data-testid="ap-goal" value={goal} onChange={(e) => setGoal(e.target.value)} style={{ padding: "0.5rem", borderRadius: 6, background: "var(--wp-dark-surface2, #1a1a1a)", color: "var(--wp-text, #eee)", border: "1px solid var(--wp-dark-border, #333)" }} />
        </label>
        <button
          type="button"
          data-testid="ap-run"
          disabled={busy}
          onClick={run}
          style={{ justifySelf: "start", padding: "0.5rem 1.1rem", borderRadius: 6, fontWeight: 700, cursor: busy ? "default" : "pointer", background: "var(--wp-gold, #e8b528)", color: "var(--wp-dark, #0b0d11)", border: "none", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Running the agent…" : "Run against ogiam.com"}
        </button>
        <p style={{ margin: 0, fontSize: "0.74rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Only ogiam.com is allowed as a target. The agent explores; nothing is ever attacked.
        </p>
      </GlassPanel>

      {error && <p data-testid="ap-error" style={{ marginTop: "1rem", color: "var(--wp-error, #ef4444)", fontSize: "0.9rem" }}>{error}</p>}

      {result && j && sc && d && (
        <div style={{ marginTop: "1.5rem", display: "grid", gap: "1.25rem" }} data-testid="ap-result">
          <div style={grid}>
            <MetricTile label="Behavior" display={j.behaviorClass.replace(/_/g, " ")} testId="ap-behavior" />
            <MetricTile label="Threat level" display={d.threatLevel} accent={THREAT_COLOR[d.threatLevel]} testId="ap-threat" />
            <MetricTile label="Intent" display={d.intent.replace(/_/g, " ")} testId="ap-intent" />
            <MetricTile label="Confidence" display={d.confidence} accent={d.confidence === "proven" ? "var(--wp-gold, #e8b528)" : undefined} testId="ap-confidence" />
          </div>

          <GlassPanel>
            <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)" }}>Path taken</div>
            <div data-testid="ap-path" style={{ marginTop: "0.4rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)", overflowX: "auto", whiteSpace: "nowrap" }}>
              {j.path.length ? j.path.join("  →  ") : "(no pages fetched)"}
            </div>
            <div style={{ marginTop: "0.9rem", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)" }}>Scaffolding fingerprint</div>
            <div style={{ marginTop: "0.4rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
              {sc.pathDiscovery}{sc.readsRobotsFirst ? ", reads robots first" : ""}{sc.probedSensitive ? ", probes sensitive paths" : ""}
            </div>
          </GlassPanel>

          <GlassPanel>
            <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)" }}>Operator dossier &middot; {d.operatorKey}</div>
            <ul data-testid="ap-evidence" style={{ margin: "0.6rem 0 0", padding: 0, listStyle: "none", display: "grid", gap: "0.35rem" }}>
              {d.evidence.map((e, i) => (
                <li key={i} style={{ fontSize: "0.82rem", color: "var(--wp-text, #eee)" }}>{e}</li>
              ))}
            </ul>
            <p data-testid="ap-disclaimer" style={{ marginTop: "0.9rem", fontSize: "0.74rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.5, fontStyle: "italic" }}>
              {d.disclaimer}
            </p>
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
