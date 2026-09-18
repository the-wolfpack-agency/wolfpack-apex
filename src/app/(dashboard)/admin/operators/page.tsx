"use client";

/**
 * Operators - the living map of operators active against your surfaces. Reads
 * GET /api/admin/operators (stored sightings grouped into per-operator dossiers)
 * and shows each ranked by threat, with its surfaces, intent, confidence, the
 * evidence, and the not-a-real-identity disclaimer shown verbatim. Auth-redirects.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, SectionHeader } from "@/components/console";

interface Operator {
  operatorKey: string;
  surfaces: string[];
  sightingCount: number;
  threatLevel: string;
  intent: string;
  confidence: string;
  evidence: string[];
  firstSeen: string;
  lastSeen: string;
  summary: string;
  disclaimer: string;
  blocked: boolean;
}

const THREAT_COLOR: Record<string, string> = {
  hostile: "var(--wp-error, #ef4444)",
  elevated: "var(--wp-warning, #f5a623)",
  benign: "var(--wp-success, #30a46c)",
};
const THREAT_RANK: Record<string, number> = { hostile: 0, elevated: 1, benign: 2 };

export default function OperatorsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/operators");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/operators");
      if (!res.ok) { setError("Could not load the operators board."); return; }
      const data = (await res.json()) as { operators?: Operator[] };
      setOperators(data.operators ?? []);
    } catch {
      setError("Could not load the operators board.");
    }
  }, []);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const setBlock = useCallback(async (operatorKey: string, block: boolean) => {
    setBusyKey(operatorKey);
    try {
      await fetchWithRefresh("/api/admin/operators/block", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ operatorKey, block }) });
      await load();
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  useEffect(() => { if (ready) void load(); }, [ready, load]);
  if (!ready) return null;

  const sorted = operators ? [...operators].sort((a, b) => (THREAT_RANK[a.threatLevel] ?? 3) - (THREAT_RANK[b.threatLevel] ?? 3)) : [];

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="operators">
      <SectionHeader title="Operators" subtitle="The operators active against your surfaces, built from stored agent sightings and ranked by threat." />
      {error && <p data-testid="operators-error" style={{ color: "var(--wp-error, #ef4444)", fontSize: "0.9rem" }}>{error}</p>}
      {operators === null && !error ? (
        <p data-testid="operators-loading" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>Loading…</p>
      ) : operators && operators.length === 0 ? (
        <GlassPanel style={{ marginTop: "1rem" }}>
          <p data-testid="operators-empty" style={{ margin: 0, fontSize: "0.9rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.55 }}>
            No operators recorded yet. As agent sightings accumulate (from a probe run or live traffic), the operators behind them appear here with their history.
          </p>
        </GlassPanel>
      ) : (
        <ul data-testid="operators-list" style={{ listStyle: "none", margin: "1rem 0 0", padding: 0, display: "grid", gap: "0.9rem" }}>
          {sorted.map((op) => (
            <li key={op.operatorKey}>
              <GlassPanel>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.95rem", color: THREAT_COLOR[op.threatLevel] ?? "var(--wp-text, #eee)" }}>{op.threatLevel}</span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>{op.operatorKey}</span>
                  <span style={{ fontSize: "0.82rem", color: "var(--wp-text, #eee)" }}>{op.intent.replace(/_/g, " ")}</span>
                  <span style={{ fontSize: "0.66rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", padding: "0.1rem 0.4rem", borderRadius: 999, background: op.confidence === "proven" ? "var(--wp-gold, #e8b528)" : "rgba(255,255,255,0.06)", color: op.confidence === "proven" ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-dim, #b4bcc8)" }}>{op.confidence}</span>
                  {op.blocked && (
                    <span data-testid={`op-blocked-${op.operatorKey}`} style={{ fontSize: "0.66rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", padding: "0.1rem 0.4rem", borderRadius: 999, background: "var(--wp-error, #ef4444)", color: "#fff" }}>blocked</span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: "0.74rem", color: "var(--wp-text-dim, #b4bcc8)" }}>{op.sightingCount} sighting(s) · {op.surfaces.length} surface(s)</span>
                  <button
                    type="button"
                    data-testid={`op-block-${op.operatorKey}`}
                    disabled={busyKey === op.operatorKey}
                    onClick={() => setBlock(op.operatorKey, !op.blocked)}
                    style={{ fontSize: "0.72rem", fontWeight: 700, padding: "0.2rem 0.6rem", borderRadius: 6, cursor: "pointer", background: op.blocked ? "transparent" : "var(--wp-error, #ef4444)", color: op.blocked ? "var(--wp-text, #eee)" : "#fff", border: op.blocked ? "1px solid var(--wp-dark-border, #333)" : "none", opacity: busyKey === op.operatorKey ? 0.6 : 1 }}
                  >
                    {op.blocked ? "Unblock" : "Block"}
                  </button>
                </div>
                <ul style={{ margin: "0.6rem 0 0", padding: 0, listStyle: "none", display: "grid", gap: "0.3rem" }}>
                  {op.evidence.map((e, i) => (
                    <li key={i} style={{ fontSize: "0.8rem", color: "var(--wp-text, #eee)" }}>{e}</li>
                  ))}
                </ul>
                <p style={{ marginTop: "0.7rem", fontSize: "0.72rem", color: "var(--wp-text-dim, #b4bcc8)", fontStyle: "italic", lineHeight: 1.5 }}>{op.disclaimer}</p>
              </GlassPanel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
