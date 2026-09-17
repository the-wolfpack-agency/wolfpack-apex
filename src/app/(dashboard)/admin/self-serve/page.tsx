"use client";

/**
 * Self-Serve admin - the OGIAM control surface for provisioning + entitlements.
 * (Distinct from /admin/ogiam, which is the governance decision explorer.)
 *
 * Two panels:
 *   Products - the OGIAM entitlements for THIS workspace (Secure Agent,
 *              Forcefield). Toggle on/off, or clear back to the default.
 *   Tenants  - the control-plane registry (operator view). While cloud
 *              provisioning is dark, an operator attaches a database to a pending
 *              tenant here to finish provisioning. Connection strings are
 *              write-only: entered here, encrypted at rest, never shown.
 *
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, StatusPill, SectionHeader } from "@/components/console";

interface EntitlementView {
  key: string;
  label: string;
  description: string;
  envDefault: boolean;
  override: boolean | null;
  effective: boolean;
}
interface TenantRow {
  tenant_id: string;
  org_name: string;
  status: string;
  has_db: boolean;
  admin_email: string | null;
  created_at: string;
}

export default function SelfServeAdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [ents, setEnts] = useState<EntitlementView[] | null>(null);
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/self-serve");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const [e, t] = await Promise.all([
        fetchWithRefresh("/api/admin/entitlements"),
        fetchWithRefresh("/api/admin/tenants"),
      ]);
      setEnts(e.ok ? ((await e.json()).entitlements ?? []) : []);
      setTenants(t.ok ? ((await t.json()).tenants ?? []) : []);
      if (!e.ok || !t.ok) setError("Some data could not be loaded.");
    } catch {
      setError("Could not load the self-serve admin.");
      setEnts([]);
      setTenants([]);
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const setFeature = useCallback(
    async (feature: string, enabled: boolean | null) => {
      try {
        const res = await fetchWithRefresh("/api/admin/entitlements", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ feature, enabled }),
        });
        if (!res.ok) setError("Could not update the product.");
        await load();
      } catch {
        setError("Could not update the product.");
      }
    },
    [load],
  );

  const attach = useCallback(
    async (tenantId: string) => {
      const connectionString = (conn[tenantId] ?? "").trim();
      if (!connectionString) return;
      try {
        const res = await fetchWithRefresh("/api/admin/tenants", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ tenantId, connectionString }),
        });
        if (!res.ok) {
          setError("Could not attach the database.");
          return;
        }
        setConn((c) => ({ ...c, [tenantId]: "" }));
        await load();
      } catch {
        setError("Could not attach the database.");
      }
    },
    [conn, load],
  );

  if (!ready) return null;

  const entList = ents ?? [];
  const tenantList = tenants ?? [];
  const btn = (bg: string): React.CSSProperties => ({
    padding: "0.35rem 0.7rem",
    borderRadius: 6,
    border: "1px solid var(--wp-border, #2a2f3a)",
    background: bg,
    color: "var(--wp-text, #e6e9ef)",
    cursor: "pointer",
    fontSize: "0.8rem",
  });

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="self-serve-admin">
      <SectionHeader title="Self-Serve admin" subtitle="Turn OGIAM products on or off per workspace, and finish provisioning new tenants." />

      <GlassPanel style={{ margin: "1.25rem 0" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Products</h3>
        {error && <p style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }} data-testid="self-serve-error">{error}</p>}
        {ents === null ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="ent-loading">Loading...</p>
        ) : (
          <div style={{ display: "grid", gap: "0.6rem" }} data-testid="ent-list">
            {entList.map((f) => (
              <div key={f.key} data-testid="ent-row" style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-surface, #171a21)" }}>
                <StatusPill status={f.effective ? "on" : "off"} tone={f.effective ? "success" : "neutral"} label={f.effective ? "On" : "Off"} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)" }}>{f.label}</div>
                  <div style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #b4bcc8)" }}>{f.description}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
                    default {f.envDefault ? "on" : "off"}{f.override !== null ? `, overridden ${f.override ? "on" : "off"}` : ""}
                  </div>
                </div>
                <button data-testid={`ent-enable-${f.key}`} onClick={() => setFeature(f.key, true)} style={btn("var(--wp-surface, #171a21)")}>Enable</button>
                <button data-testid={`ent-disable-${f.key}`} onClick={() => setFeature(f.key, false)} style={btn("var(--wp-surface, #171a21)")}>Disable</button>
                {f.override !== null && (
                  <button data-testid={`ent-clear-${f.key}`} onClick={() => setFeature(f.key, null)} style={btn("transparent")}>Clear</button>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      <GlassPanel>
        <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Tenants</h3>
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.83rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          The provisioning registry. While cloud provisioning is off, attach a database to a pending tenant to finish setup. The connection string is stored encrypted and never shown back.
        </p>
        {tenants === null ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="tenant-loading">Loading...</p>
        ) : tenantList.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="tenant-empty">No tenants registered yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="tenant-list">
            {tenantList.map((t) => (
              <div key={t.tenant_id} data-testid="tenant-row" style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-surface, #171a21)" }}>
                <StatusPill status={t.status} tone={t.status === "active" ? "success" : t.status === "offboarded" ? "error" : "info"} label={t.status} />
                <span style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)" }}>{t.org_name}</span>
                <code style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.8rem" }}>{t.tenant_id}</code>
                {t.has_db ? (
                  <span style={{ marginLeft: "auto", color: "var(--wp-success, #30a46c)", fontSize: "0.8rem" }} data-testid="tenant-has-db">database attached</span>
                ) : (
                  <span style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
                    <input
                      type="password"
                      placeholder="postgres://..."
                      value={conn[t.tenant_id] ?? ""}
                      onChange={(e) => setConn((c) => ({ ...c, [t.tenant_id]: e.target.value }))}
                      data-testid={`tenant-conn-${t.tenant_id}`}
                      style={{ padding: "0.35rem 0.5rem", borderRadius: 6, background: "var(--wp-panel, #14171d)", color: "var(--wp-text, #e6e9ef)", border: "1px solid var(--wp-border, #2a2f3a)", fontSize: "0.8rem" }}
                    />
                    <button data-testid={`tenant-attach-${t.tenant_id}`} onClick={() => attach(t.tenant_id)} style={btn("var(--wp-accent, #4c8bf5)")}>Attach DB</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
