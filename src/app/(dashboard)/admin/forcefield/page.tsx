"use client";

/**
 * Forcefield - the deception grid console.
 *
 * Canaries are decoys that nothing legitimate ever touches: a fake credential
 * seeded in a table, a decoy admin route, a honey-row, a honeypot tool. Any
 * interaction is a high-confidence signal, so a touch trips containment
 * automatically (the agent is revoked and the trip is recorded). This page lets
 * an operator SEED and RETIRE decoys and see what is live.
 *
 * DECEPTION SAFETY: the decoy VALUE never leaves the store. The list shows a
 * masked hint (last 4 chars) so an operator can recognise a decoy without the
 * value being visible to defeat the trap.
 *
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, SectionHeader } from "@/components/console";
import { assessDeceptionCoverage } from "@/lib/forcefield/deception-coverage";
import { THREAT_COVERAGE, coverageSummary, type CoverageStatus } from "@/lib/forcefield/threat-coverage";

type CanaryKind = "token" | "route" | "row" | "tool";

interface CanaryDisplay {
  id: string;
  kind: CanaryKind;
  seededIn: string;
  valueHint: string;
  active: boolean;
  createdAt: string;
}

interface CanaryTrip {
  id: string;
  agent: string;
  whenIso: string;
  riskTier: string;
  reason: string;
  contained: boolean;
}

const KINDS: { kind: CanaryKind; label: string; hint: string; placeholder: string }[] = [
  { kind: "token", label: "Token", hint: "A fake credential. Trips if it ever leaves in a payload.", placeholder: "sk-decoy-DO-NOT-USE-..." },
  { kind: "route", label: "Route", hint: "A decoy endpoint no legitimate flow calls.", placeholder: "/admin/export-all" },
  { kind: "row", label: "Row", hint: "A honey-row id seeded into the data.", placeholder: "row-honey-42" },
  { kind: "tool", label: "Tool", hint: "A honeypot tool a hijacked agent reaches for.", placeholder: "export_all_customer_data" },
];

function fmtDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString();
}

export default function ForcefieldPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [canaries, setCanaries] = useState<CanaryDisplay[] | null>(null);
  const [trips, setTrips] = useState<CanaryTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed form.
  const [kind, setKind] = useState<CanaryKind>("token");
  const [value, setValue] = useState("");
  const [seededIn, setSeededIn] = useState("");
  const [saving, setSaving] = useState(false);
  const [seedingGrid, setSeedingGrid] = useState(false);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/forcefield");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/canaries");
      if (!res.ok) {
        setError("Could not load the deception grid.");
        setCanaries([]);
        return;
      }
      const data = (await res.json()) as { canaries?: CanaryDisplay[] };
      setCanaries(Array.isArray(data.canaries) ? data.canaries : []);
    } catch {
      setError("Could not load the deception grid.");
      setCanaries([]);
    }
  }, []);

  const loadTrips = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/trips");
      if (!res.ok) {
        setTrips([]);
        return;
      }
      const data = (await res.json()) as { trips?: CanaryTrip[] };
      setTrips(Array.isArray(data.trips) ? data.trips : []);
    } catch {
      setTrips([]);
    }
  }, []);

  useEffect(() => {
    if (ready) {
      void load();
      void loadTrips();
    }
  }, [ready, load, loadTrips]);

  // Seed a diverse grid: ensure one active decoy of EACH kind exists so
  // coverage is never accidentally thin. Idempotent server-side.
  const seedGrid = useCallback(async () => {
    if (seedingGrid) return;
    setSeedingGrid(true);
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/grid", { method: "POST", headers: jsonHeaders() });
      if (res.ok) await load();
      else setError("Could not seed the deception grid.");
    } catch {
      setError("Could not seed the deception grid.");
    } finally {
      setSeedingGrid(false);
    }
  }, [seedingGrid, load]);

  const seed = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!value.trim() || !seededIn.trim() || saving) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetchWithRefresh("/api/admin/forcefield/canaries", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ kind, value: value.trim(), seededIn: seededIn.trim() }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setError(d.error || "Could not seed the decoy.");
          return;
        }
        setValue("");
        setSeededIn("");
        await load();
      } catch {
        setError("Could not seed the decoy.");
      } finally {
        setSaving(false);
      }
    },
    [kind, value, seededIn, saving, load],
  );

  const retire = useCallback(
    async (id: string) => {
      try {
        const res = await fetchWithRefresh(`/api/admin/forcefield/canaries?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          setError("Could not retire the decoy.");
          return;
        }
        await load();
      } catch {
        setError("Could not retire the decoy.");
      }
    },
    [load],
  );

  if (!ready) return null;

  const list = canaries ?? [];
  const active = list.filter((c) => c.active);
  const kindsInUse = new Set(active.map((c) => c.kind)).size;
  const activeKind = KINDS.find((k) => k.kind === kind);
  const tripList = trips ?? [];

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield">
      <SectionHeader
        title="Forcefield"
        subtitle="Decoys nothing legitimate ever touches. A single touch trips containment automatically."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", margin: "1.25rem 0" }}>
        <MetricTile label="Active decoys" display={String(active.length)} accent="var(--wp-success, #30a46c)" testId="metric-active" />
        <MetricTile label="Retired" display={String(list.length - active.length)} testId="metric-retired" />
        <MetricTile label="Decoy types in use" display={`${kindsInUse} / 4`} testId="metric-kinds" />
        <MetricTile label="Trips" display={String(tripList.length)} accent={tripList.length ? "var(--wp-error, #e5484d)" : undefined} testId="metric-trips" />
      </div>

      {(() => {
        const cov = assessDeceptionCoverage(list, tripList.length);
        return (
          <GlassPanel style={{ marginBottom: "1.25rem" }}>
            <div data-testid="deception-coverage" style={{ display: "grid", gap: "0.6rem" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Deception coverage</h3>
                <span data-testid="coverage-kinds" style={{ fontSize: "0.82rem", fontWeight: 700, color: cov.gaps.length ? "var(--wp-warning, #f5a623)" : "var(--wp-success, #30a46c)" }}>
                  {cov.kindsSeeded} / {cov.totalKinds} decoy kinds seeded
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {cov.byKind.map((k) => (
                  <span
                    key={k.kind}
                    data-testid={`coverage-kind-${k.kind}`}
                    style={{
                      fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em",
                      borderRadius: 999, padding: "0.12rem 0.5rem",
                      color: k.seeded ? "var(--wp-success, #30a46c)" : "var(--wp-warning, #f5a623)",
                      border: `1px solid ${k.seeded ? "var(--wp-success, #30a46c)" : "var(--wp-warning, #f5a623)"}`,
                    }}
                  >
                    {k.kind} {k.seeded ? `✓ ${k.active}` : "- gap"}
                  </span>
                ))}
              </div>
              <p data-testid="coverage-assessment" style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.55, color: "var(--wp-text-muted, #929cad)", maxWidth: "78ch" }}>
                {cov.assessment}
              </p>
              {cov.gaps.length > 0 && (
                <button
                  type="button"
                  data-testid="coverage-seed-grid"
                  onClick={seedGrid}
                  disabled={seedingGrid}
                  style={{
                    justifySelf: "start", padding: "0.35rem 0.8rem", borderRadius: 6, fontSize: "0.8rem", fontWeight: 600,
                    cursor: seedingGrid ? "default" : "pointer", background: "var(--wp-gold, #c9a227)", color: "#0b0d11", border: "none",
                  }}
                >
                  {seedingGrid ? "Seeding..." : "Seed missing decoy kinds"}
                </button>
              )}
            </div>
          </GlassPanel>
        );
      })()}

      {(() => {
        const sum = coverageSummary();
        const STATUS_COLOR: Record<CoverageStatus, string> = {
          covered: "var(--wp-success, #30a46c)",
          partial: "var(--wp-gold, #c9a227)",
          gap: "var(--wp-error, #e5484d)",
          "not-agent-observable": "var(--wp-text-muted, #929cad)",
        };
        const FAMILY_LABEL: Record<string, string> = {
          "cwe-top-25": "CWE Top 25",
          "exposure-recon": "Exposure / recon",
          "agent-llm": "Agent / LLM-specific",
        };
        const families = ["cwe-top-25", "exposure-recon", "agent-llm"] as const;
        return (
          <GlassPanel style={{ marginBottom: "1.25rem" }}>
            <div data-testid="threat-coverage" style={{ display: "grid", gap: "0.7rem" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Threat coverage</h3>
                <span data-testid="coverage-headline" style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--wp-success, #30a46c)" }}>
                  {sum.observableDetected} / {sum.observableTotal} agent-observable threats detected
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #929cad)" }}>
                  {sum.notAgentObservable} code-level (out of scope for agent traffic)
                </span>
              </div>

              {sum.gaps.length > 0 && (
                <div data-testid="coverage-gaps" style={{ display: "grid", gap: "0.3rem", padding: "0.5rem 0.7rem", borderRadius: 6, border: "1px solid var(--wp-error, #e5484d)" }}>
                  <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-error, #e5484d)" }}>
                    {sum.gaps.length} gaps to close (not caught off guard)
                  </span>
                  {sum.gaps.map((g) => (
                    <span key={g.id} style={{ fontSize: "0.78rem", color: "var(--wp-text, #e6e9ef)" }}>
                      <strong>{g.id}</strong> {g.name} - <span style={{ color: "var(--wp-text-muted, #929cad)" }}>{g.note}</span>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                  <tbody>
                    {families.map((fam) => (
                      <Fragment key={fam}>
                        <tr><td colSpan={3} style={{ padding: "0.5rem 0 0.2rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #929cad)" }}>{FAMILY_LABEL[fam]}</td></tr>
                        {THREAT_COVERAGE.filter((e) => e.family === fam).map((e) => (
                          <tr key={e.id} data-testid={`coverage-row-${e.id}`} style={{ borderTop: "1px solid var(--wp-border, #262b34)" }}>
                            <td style={{ padding: "0.25rem 0.5rem 0.25rem 0", whiteSpace: "nowrap", fontFamily: "var(--wp-mono, ui-monospace, monospace)", color: "var(--wp-text-muted, #929cad)" }}>{e.id}</td>
                            <td style={{ padding: "0.25rem 0.5rem", color: "var(--wp-text, #e6e9ef)" }}>{e.name}</td>
                            <td style={{ padding: "0.25rem 0", whiteSpace: "nowrap", textAlign: "right" }}>
                              <span style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", color: STATUS_COLOR[e.status] }}>{e.status.replace(/-/g, " ")}</span>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </GlassPanel>
        );
      })()}

      <GlassPanel style={{ marginBottom: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Seed a decoy</h3>
        <form onSubmit={seed} style={{ display: "grid", gap: "0.7rem" }} data-testid="seed-form">
          <label style={{ display: "grid", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Type</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as CanaryKind)}
              data-testid="seed-kind"
              style={{ padding: "0.5rem", borderRadius: 8, background: "var(--wp-surface, #171a21)", color: "var(--wp-text, #e6e9ef)", border: "1px solid var(--wp-border, #2a2f3a)" }}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </select>
            {activeKind && <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #b4bcc8)" }}>{activeKind.hint}</span>}
          </label>
          <label style={{ display: "grid", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Decoy value</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={activeKind?.placeholder}
              data-testid="seed-value"
              style={{ padding: "0.5rem", borderRadius: 8, background: "var(--wp-surface, #171a21)", color: "var(--wp-text, #e6e9ef)", border: "1px solid var(--wp-border, #2a2f3a)" }}
            />
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Stored securely. Only a masked hint is ever shown back.</span>
          </label>
          <label style={{ display: "grid", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Where it is seeded</span>
            <input
              value={seededIn}
              onChange={(e) => setSeededIn(e.target.value)}
              placeholder="customers table"
              data-testid="seed-seededin"
              style={{ padding: "0.5rem", borderRadius: 8, background: "var(--wp-surface, #171a21)", color: "var(--wp-text, #e6e9ef)", border: "1px solid var(--wp-border, #2a2f3a)" }}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={saving || !value.trim() || !seededIn.trim()}
              data-testid="seed-submit"
              style={{ padding: "0.55rem 1.1rem", borderRadius: 8, border: "none", background: "var(--wp-accent, #4c8bf5)", color: "#fff", fontWeight: 600, cursor: saving ? "default" : "pointer", opacity: saving || !value.trim() || !seededIn.trim() ? 0.6 : 1 }}
            >
              {saving ? "Seeding..." : "Seed decoy"}
            </button>
          </div>
        </form>
      </GlassPanel>

      <GlassPanel>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Deception grid</h3>
        {error && <p style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }} data-testid="ff-error">{error}</p>}
        {canaries === null ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="ff-loading">Loading...</p>
        ) : list.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="ff-empty">
            No decoys seeded yet. Seed one above and any touch of it trips containment.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="ff-list">
            {list.map((c) => (
              <div
                key={c.id}
                data-testid="ff-row"
                style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-surface, #171a21)", opacity: c.active ? 1 : 0.55 }}
              >
                <StatusPill status={c.active ? "active" : "retired"} tone={c.active ? "success" : "neutral"} label={c.active ? "Active" : "Retired"} />
                <span style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)", textTransform: "capitalize" }}>{c.kind}</span>
                <code style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.85rem" }}>{c.valueHint}</code>
                <span style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.85rem" }}>in {c.seededIn}</span>
                <span style={{ marginLeft: "auto", color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.8rem" }}>{fmtDate(c.createdAt)}</span>
                {c.active && (
                  <button
                    onClick={() => retire(c.id)}
                    data-testid="ff-retire"
                    style={{ padding: "0.35rem 0.7rem", borderRadius: 6, border: "1px solid var(--wp-border, #2a2f3a)", background: "transparent", color: "var(--wp-text-dim, #b4bcc8)", cursor: "pointer", fontSize: "0.8rem" }}
                  >
                    Retire
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      <GlassPanel style={{ marginTop: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Recent trips</h3>
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Each trip is a decoy that was touched. The acting agent was quarantined and the event recorded automatically.
        </p>
        {trips === null ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="trips-loading">Loading...</p>
        ) : tripList.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="trips-empty">
            No trips. Nothing has touched a decoy - that is the good state.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="trips-list">
            {tripList.map((t) => (
              <div
                key={t.id}
                data-testid="trip-row"
                style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-surface, #171a21)" }}
              >
                <StatusPill status={t.contained ? "contained" : t.riskTier} tone={t.contained ? "error" : undefined} label={t.contained ? "Contained" : t.riskTier} />
                <code style={{ color: "var(--wp-text, #e6e9ef)", fontSize: "0.85rem" }}>{t.agent}</code>
                <span style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.85rem", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.reason}</span>
                <span style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.8rem", whiteSpace: "nowrap" }}>{fmtDate(t.whenIso)}</span>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
