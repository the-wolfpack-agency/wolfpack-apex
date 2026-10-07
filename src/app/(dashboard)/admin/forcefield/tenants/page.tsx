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

interface Tenant { id: string; name: string; siteLabel: string; status: string; createdAt: string; plan?: string; subscriptionStatus?: string; sharesIntel?: boolean }
const PLAN_OPTIONS = ["none", "starter", "growth", "scale", "enterprise"] as const;
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
  const [mgmtBusy, setMgmtBusy] = useState<string | null>(null);
  const [rotated, setRotated] = useState<{ id: string; name: string; token: string } | null>(null);

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

  // Token lifecycle: kill a leaked token (disable), restore it (enable), or rotate
  // to a brand-new token (shown once). The response to a suspected compromise.
  async function manage(t: Tenant, action: "disable" | "enable" | "rotate" | "intel_on" | "intel_off") {
    setMgmtBusy(t.id); setError(null); setRotated(null);
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/tenants/manage", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ id: t.id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        if (action === "rotate" && body.token) setRotated({ id: t.id, name: t.name, token: body.token as string });
        void load();
      } else {
        setError(body.error ? `Could not ${action}: ${body.error}` : `Could not ${action} (HTTP ${res.status}).`);
      }
    } catch (err) { setError((err as Error).message); }
    setMgmtBusy(null);
  }

  // License a client (the manual path): choosing a plan activates the
  // subscription; choosing "none" unlicenses. Decoupled from the token kill-switch.
  async function setLicense(t: Tenant, plan: string) {
    setMgmtBusy(t.id); setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/tenants/billing", {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ id: t.id, plan, status: plan === "none" ? "none" : "active" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) void load();
      else setError(body.error ? `Could not set plan: ${body.error}` : `Could not set plan (HTTP ${res.status}).`);
    } catch (err) { setError((err as Error).message); }
    setMgmtBusy(null);
  }

  if (!ready) return null;

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield-tenants">
      <SectionHeader title="Forcefield tenants" subtitle="Onboard a client: issue an ingest key and hand them the ready-to-paste config." />
      <p style={{ marginTop: ".4rem", fontSize: ".8rem" }}>
        <a href="/admin/forcefield/signups" style={{ color: "var(--wp-gold)" }}>Signup requests</a>
        {" · "}
        <a href="/admin/forcefield/docs" style={{ color: "var(--wp-gold)" }}>Docs (pricing, licensing, SLA, legal)</a>
        {" · "}
        <a href="/admin/trust-center" style={{ color: "var(--wp-gold)" }}>Trust Center</a>
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

      {rotated ? (
        <GlassPanel testId="tn-rotated" style={{ marginTop: "1.25rem", border: "1px solid var(--wp-gold)" }}>
          <div style={{ color: "var(--wp-gold)", fontWeight: 600 }}>{rotated.name}: new token issued.</div>
          <p style={{ marginTop: ".4rem", color: "var(--wp-text-dim)", fontSize: ".85rem" }}>
            The old token stopped working immediately. Copy this now, it is shown once, and send it to the client.
          </p>
          <pre data-testid="tn-rotated-token" style={{ marginTop: 4, padding: ".6rem .75rem", background: "var(--wp-dark-surface)", border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)", overflowX: "auto" }}>{rotated.token}</pre>
        </GlassPanel>
      ) : null}

      <GlassPanel style={{ marginTop: "1.25rem" }}>
        <div style={{ fontSize: ".8rem", color: "var(--wp-text-dim)", marginBottom: ".6rem" }}>Onboarded tenants</div>
        {tenants.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim)" }}>No tenants yet. Issue the first key above.</p>
        ) : (
          <table data-testid="t-list" style={{ width: "100%", borderCollapse: "collapse", fontSize: ".85rem" }}>
            <thead><tr style={{ textAlign: "left", color: "var(--wp-text-dim)" }}>
              <th style={{ padding: ".4rem .5rem" }}>Client</th><th style={{ padding: ".4rem .5rem" }}>Site</th><th style={{ padding: ".4rem .5rem" }}>Status</th><th style={{ padding: ".4rem .5rem" }}>Plan</th><th style={{ padding: ".4rem .5rem" }}>Onboarded</th><th style={{ padding: ".4rem .5rem" }}></th>
            </tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} data-testid={`tn-row-${t.id}`} style={{ borderTop: "1px solid var(--wp-border)", color: "var(--wp-text)" }}>
                  <td style={{ padding: ".4rem .5rem" }}>{t.name}</td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.siteLabel}</td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.status}</td>
                  <td style={{ padding: ".4rem .5rem" }}>
                    <select data-testid={`tn-plan-${t.id}`} value={t.plan ?? "none"} disabled={mgmtBusy === t.id}
                      onChange={(e) => setLicense(t, e.target.value)}
                      style={{ background: "var(--wp-dark-surface)", color: "var(--wp-text)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".2rem .3rem", fontSize: ".8rem" }}>
                      {PLAN_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    {t.subscriptionStatus && t.subscriptionStatus !== "none" ? (
                      <span style={{ marginLeft: 6, fontSize: ".72rem", color: t.subscriptionStatus === "active" || t.subscriptionStatus === "trialing" ? "var(--wp-success, #22c55e)" : "var(--wp-error, #e5484d)" }}>{t.subscriptionStatus}</span>
                    ) : null}
                  </td>
                  <td style={{ padding: ".4rem .5rem" }}>{t.createdAt.slice(0, 10)}</td>
                  <td style={{ padding: ".4rem .5rem", whiteSpace: "nowrap" }}>
                    {t.status === "active" ? (
                      <button data-testid={`tn-disable-${t.id}`} onClick={() => manage(t, "disable")} disabled={mgmtBusy === t.id}
                        title="Kill this token (reversible)"
                        style={{ background: "transparent", color: "var(--wp-error, #e5484d)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".3rem .6rem", marginRight: 6, cursor: "pointer" }}>Disable</button>
                    ) : (
                      <button data-testid={`tn-enable-${t.id}`} onClick={() => manage(t, "enable")} disabled={mgmtBusy === t.id}
                        style={{ background: "transparent", color: "var(--wp-text-dim)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".3rem .6rem", marginRight: 6, cursor: "pointer" }}>Enable</button>
                    )}
                    <button data-testid={`tn-rotate-${t.id}`} onClick={() => manage(t, "rotate")} disabled={mgmtBusy === t.id}
                      title="Issue a new token; the old one stops working"
                      style={{ background: "transparent", color: "var(--wp-gold)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".3rem .6rem", cursor: "pointer", marginRight: 6 }}>Rotate</button>
                    <button data-testid={`tn-intel-${t.id}`} onClick={() => manage(t, t.sharesIntel === false ? "intel_on" : "intel_off")} disabled={mgmtBusy === t.id}
                      title="Shared threat-intel network participation (opaque attacker fingerprints only)"
                      style={{ background: "transparent", color: "var(--wp-text-dim)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".3rem .6rem", cursor: "pointer" }}>
                      {t.sharesIntel === false ? "Intel: off" : "Intel: on"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassPanel>
    </div>
  );
}
