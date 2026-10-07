"use client";

/**
 * Forcefield signup review - the operator gate behind public self-serve.
 *
 * Lists PENDING signup requests. Approve provisions the client's tenant and shows
 * the ingest token + ready-to-paste config ONCE (copy it, hand it over, it is
 * stored only hashed). Reject closes the request. This is the human checkpoint
 * that keeps token issuance gated until billing + abuse controls are live.
 *
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, SectionHeader } from "@/components/console";

interface Request { id: string; name: string; email: string; siteUrl: string; note: string | null; status: string; createdAt: string }
interface Tenant { id: string; name: string; siteLabel: string; status: string; createdAt: string }
interface Quickstart { token: string; cloudflareEnv: Record<string, string>; nextEnv: Record<string, string>; nextSnippet: string }
interface Approved { tenant: Tenant; token: string; quickstart: Quickstart }

function envBlock(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

const SUMMARY_UNAVAILABLE: Record<string, string> = {
  unavailable: "AI summary unavailable right now.",
  no_provider: "AI summary not configured.",
  over_budget: "AI summary paused (budget reached).",
};

export default function ForcefieldSignupsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [requests, setRequests] = useState<Request[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Approved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, { loading?: boolean; text?: string }>>({});

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) { router.push("/login?next=/admin/forcefield/signups"); return; }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/signups?status=pending");
      if (res.ok) setRequests((await res.json()).requests ?? []);
    } catch { /* leave the list as-is on a transient error */ }
  }, []);
  useEffect(() => { if (ready) void load(); }, [ready, load]);

  const decide = useCallback(async (id: string, action: "approve" | "reject") => {
    setBusyId(id); setError(null); setApproved(null);
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/signups", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        if (action === "approve" && body.token) setApproved(body as Approved);
        void load();
      } else {
        setError(body.error ? `Could not ${action}: ${body.error}` : `Could not ${action} (HTTP ${res.status}).`);
      }
    } catch (err) { setError((err as Error).message); }
    setBusyId(null);
  }, [load]);

  // Advisory AI risk/fit summary, routed through the central model router. Never
  // blocks the review; an unavailable summary shows an inline note.
  const summarize = useCallback(async (id: string) => {
    setSummaries((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/signups/risk-summary", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => ({}));
      const text = body.ok ? String(body.summary) : (SUMMARY_UNAVAILABLE[body.reason] ?? "AI summary unavailable right now.");
      setSummaries((s) => ({ ...s, [id]: { text } }));
    } catch {
      setSummaries((s) => ({ ...s, [id]: { text: "AI summary unavailable right now." } }));
    }
  }, []);

  if (!ready) return null;

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield-signups">
      <SectionHeader title="Forcefield signups" subtitle="Review self-serve requests. Approve to provision the tenant and issue its key." />
      <p style={{ marginTop: ".4rem", fontSize: ".8rem" }}>
        <a href="/admin/forcefield/tenants" style={{ color: "var(--wp-gold)" }}>Tenants</a>
        {" · "}
        <a href="/admin/forcefield/docs" style={{ color: "var(--wp-gold)" }}>Docs (pricing, licensing, SLA, legal)</a>
      </p>

      {approved ? (
        <GlassPanel testId="s-approved" style={{ marginTop: "1.25rem", border: "1px solid var(--wp-gold)" }}>
          <div style={{ color: "var(--wp-gold)", fontWeight: 600 }}>{approved.tenant.name} is onboarded.</div>
          <p style={{ marginTop: ".4rem", color: "var(--wp-text-dim)", fontSize: ".85rem" }}>
            Copy this now, it is shown once. The token is stored only as a hash and cannot be recovered.
          </p>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Ingest token</div>
          <pre data-testid="s-token" style={preStyle}>{approved.token}</pre>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Cloudflare Worker env</div>
          <pre style={{ ...preStyle, fontSize: ".78rem" }}>{envBlock(approved.quickstart.cloudflareEnv)}</pre>
          <div style={{ marginTop: ".9rem", fontSize: ".8rem", color: "var(--wp-text-dim)" }}>Next.js middleware</div>
          <pre style={{ ...preStyle, fontSize: ".78rem" }}>{approved.quickstart.nextSnippet + "\n\n" + envBlock(approved.quickstart.nextEnv)}</pre>
        </GlassPanel>
      ) : null}

      {error ? <p data-testid="s-error" style={{ marginTop: ".75rem", color: "var(--wp-error, #e5484d)" }}>{error}</p> : null}

      <GlassPanel style={{ marginTop: "1.25rem" }}>
        <div style={{ fontSize: ".8rem", color: "var(--wp-text-dim)", marginBottom: ".6rem" }}>Pending requests</div>
        {requests.length === 0 ? (
          <p data-testid="s-empty" style={{ color: "var(--wp-text-dim)" }}>No pending requests.</p>
        ) : (
          <table data-testid="s-list" style={{ width: "100%", borderCollapse: "collapse", fontSize: ".85rem" }}>
            <thead><tr style={{ textAlign: "left", color: "var(--wp-text-dim)" }}>
              <th style={{ padding: ".4rem .5rem" }}>Name</th><th style={{ padding: ".4rem .5rem" }}>Email</th><th style={{ padding: ".4rem .5rem" }}>Site</th><th style={{ padding: ".4rem .5rem" }}>Requested</th><th style={{ padding: ".4rem .5rem" }}></th>
            </tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} data-testid={`s-row-${r.id}`} style={{ borderTop: "1px solid var(--wp-border)", color: "var(--wp-text)", verticalAlign: "top" }}>
                  <td style={{ padding: ".5rem" }}>
                    {r.name}{r.note ? <div style={{ color: "var(--wp-text-dim)", fontSize: ".78rem", marginTop: 2 }}>{r.note}</div> : null}
                    {summaries[r.id]?.loading ? (
                      <div data-testid={`s-summary-${r.id}`} style={{ color: "var(--wp-text-dim)", fontSize: ".78rem", marginTop: 4, fontStyle: "italic" }}>Summarizing…</div>
                    ) : summaries[r.id]?.text ? (
                      <div data-testid={`s-summary-${r.id}`} style={{ color: "var(--wp-text-dim)", fontSize: ".78rem", marginTop: 4, borderLeft: "2px solid var(--wp-gold)", paddingLeft: 6 }}>{summaries[r.id]?.text}</div>
                    ) : null}
                  </td>
                  <td style={{ padding: ".5rem" }}>{r.email}</td>
                  <td style={{ padding: ".5rem" }}>{r.siteUrl}</td>
                  <td style={{ padding: ".5rem" }}>{r.createdAt.slice(0, 10)}</td>
                  <td style={{ padding: ".5rem", whiteSpace: "nowrap" }}>
                    <button data-testid={`s-approve-${r.id}`} onClick={() => decide(r.id, "approve")} disabled={busyId === r.id}
                      style={{ background: "var(--wp-gold)", color: "var(--wp-dark)", border: "none", borderRadius: 6, padding: ".35rem .7rem", fontWeight: 600, cursor: busyId === r.id ? "wait" : "pointer", marginRight: 6 }}>
                      {busyId === r.id ? "…" : "Approve"}
                    </button>
                    <button data-testid={`s-reject-${r.id}`} onClick={() => decide(r.id, "reject")} disabled={busyId === r.id}
                      style={{ background: "transparent", color: "var(--wp-text-dim)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".35rem .7rem", cursor: busyId === r.id ? "wait" : "pointer", marginRight: 6 }}>
                      Reject
                    </button>
                    <button data-testid={`s-summarize-${r.id}`} onClick={() => summarize(r.id)} disabled={summaries[r.id]?.loading}
                      title="AI risk/fit summary (advisory)"
                      style={{ background: "transparent", color: "var(--wp-gold)", border: "1px solid var(--wp-border)", borderRadius: 6, padding: ".35rem .7rem", cursor: summaries[r.id]?.loading ? "wait" : "pointer" }}>
                      AI summary
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

const preStyle: React.CSSProperties = {
  marginTop: 4, padding: ".6rem .75rem", background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-border)", borderRadius: 6, color: "var(--wp-text)", overflowX: "auto",
};
