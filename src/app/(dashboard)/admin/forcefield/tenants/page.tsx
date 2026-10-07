"use client";

/**
 * Forcefield tenants - onboard a client.
 *
 * Lists onboarded tenants and provisions a new one: enter a name + a public site
 * label, and the backend issues an ingest token + the ready-to-paste adapter
 * config. The token + quick-start are shown ONCE here (the token is stored only
 * as a hash and can never be recovered), so the operator copies them and hands
 * them to the client. Watch-first: the config ships with enforcement off.
 *
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, SectionHeader } from "@/components/console";

interface Tenant { id: string; name: string; siteLabel: string; status: string; createdAt: string }
interface Quickstart {
  token: string; ingestUrl: string; rulesetUrl: string;
  cloudflareEnv: Record<string, string>; nextEnv: Record<string, string>; nextSnippet: string;
}
interface Created { tenant: Tenant; token: string; quickstart: Quickstart }

function envBlock(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

export default function ForcefieldTenantsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [name, setName] = useState("");
  const [siteLabel, setSiteLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) { router.push("/login?next=/admin/forcefield/tenants"); return; }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/tenants");
      if (res.ok) setTenants((await res.json()).tenants ?? []);
    } catch { /* leave the list as-is on a transient error */ }
  }, []);
  useEffect(() => { if (ready) void load(); }, [ready, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setCreated(null);
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/tenants", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name, siteLabel }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setCreated(body as Created);
        setName(""); setSiteLabel("");
        void load();
      } else {
        setError(body.error === "invalid_name_or_site" ? "Enter a client name and a site label (2+ characters each)." : (body.error || `Could not create (HTTP ${res.status}).`));
      }
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  if (!ready) return null;

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield-tenants">
      <SectionHeader title="Forcefield tenants" subtitle="Onboard a client: issue an ingest key and hand them the ready-to-paste config." />
      <p style={{ marginTop: ".4rem", fontSize: ".8rem" }}>
        <a href="/admin/forcefield/signups" style={{ color: "var(--wp-gold)" }}>Signup requests</a>
        {" · "}
        <a href="/admin/forcefield/docs" style={{ color: "var(--wp-gold)" }}>Docs (pricing, licensing, SLA, legal)</a>
      </p>

      <GlassPanel style={{ marginTop: "1.25rem" }}>
        <form onSubmit={create} data-testid="tenant-form" style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: ".8rem", color: "var(--wp-text-dim)" }}>
            Client name
            <input data-testid="t-name" value={name} onChange={(e) => setName(e.target.value)} required
              style={{ padding: ".5rem .6rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: ".8rem", color: "var(--wp-text-dim)" }}>
            Site label (e.g. beforeutrade)
            <input data-testid="t-site" value={siteLabel} onChange={(e) => setSiteLabel(e.target.value)} required
              style={{ padding: ".5rem .6rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)" }} />
          </label>
          <button type="submit" data-testid="t-submit" disabled={busy}
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)", border: "none", borderRadius: 6, padding: ".6rem 1rem", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Issuing…" : "Issue key"}
          </button>
        </form>
        {error ? <p data-testid="t-error" style={{ marginTop: ".75rem", color: "var(--wp-error, #e5484d)" }}>{error}</p> : null}
      </GlassPanel>

      {created ? (
        <GlassPanel testId="t-created" style={{ marginTop: "1.25rem", border: "1px solid var(--wp-gold)" }}>
          <div style={{ color: "var(--wp-gold)", fontWeight: 600 }}>{created.tenant.name} is onboarded.</div>
          <p style={{ marginTop: ".4rem", color: "var(--wp-text-dim)", fontSize: ".85rem" }}>
            Copy this now, it is shown once. The token is stored only as a hash and cannot be recovered.
          </p>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Ingest token</div>
          <pre data-testid="t-token" style={{ marginTop: 4, padding: ".6rem .75rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)", overflowX: "auto" }}>{created.token}</pre>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Cloudflare Worker env (any site)</div>
          <pre style={{ marginTop: 4, padding: ".6rem .75rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)", overflowX: "auto", fontSize: ".78rem" }}>{envBlock(created.quickstart.cloudflareEnv)}</pre>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Next.js middleware</div>
          <pre style={{ marginTop: 4, padding: ".6rem .75rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)", overflowX: "auto", fontSize: ".78rem" }}>{created.quickstart.nextSnippet + "\n\n" + envBlock(created.quickstart.nextEnv)}</pre>
        </GlassPanel>
      ) : null}

      <GlassPanel style={{ marginTop: "1.25rem" }}>
        <div style={{ fontSize: ".8rem", color: "var(--wp-text-dim)", marginBottom: ".6rem" }}>Onboarded tenants</div>
        {tenants.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim)" }}>No tenants yet. Issue the first key above.</p>
        ) : (
          <table data-testid="t-list" style={{ width: "100%", borderCollapse: "collapse", fontSize: ".85rem" }}>
            <thead><tr style={{ textAlign: "left", color: "var(--wp-text-dim)" }}>
              <th style={{ padding: ".4rem .5rem" }}>Client</th><th style={{ padding: ".4rem .5rem" }}>Site</th><th style={{ padding: ".4rem .5rem" }}>Status</th><th style={{ padding: ".4rem .5rem" }}>Onboarded</th>
            </tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--wp-border)", color: "var(--wp-text)" }}>
                  <td style={{ padding: ".4rem .5rem" }}>{t.name}</td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.siteLabel}</td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.status}</td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.createdAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassPanel>
    </div>
  );
}
