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
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, SectionHeader } from "@/components/console";

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
