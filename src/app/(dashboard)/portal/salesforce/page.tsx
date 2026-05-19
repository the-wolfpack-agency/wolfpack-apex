"use client";

/**
 * /portal/salesforce — Salesforce mini-dashboard.
 *
 * Proof-of-pattern surface that turns the existing assistant connector
 * framework into a full page widget. Three sections:
 *   1. Pipeline Snapshot — total open opps, $ in pipeline, by-stage.
 *   2. Quick links + create buttons for the three drill-in lists.
 *   3. Recent Activity — 10 most-recently-modified records.
 *
 * No Salesforce row → render a "Connect Salesforce" CTA pointing at
 * /admin/connectors. Page never throws.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";
import SalesforceCreateModal from "@/components/SalesforceCreateModal";

interface PipelineSnapshot {
  openCount: number;
  totalAmount: number;
  byStage: Array<{ stage: string; count: number; amount: number }>;
}

interface RecentRecord {
  id: string;
  name: string;
  type: "contacts" | "opportunities" | "accounts";
  lastModified: string | null;
}

interface DashboardResponse {
  notConfigured: boolean;
  pipeline: PipelineSnapshot;
  recent: RecentRecord[];
  connector: string;
}

export default function SalesforcePortalPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState<null | "contacts" | "opportunities" | "accounts">(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/portal/salesforce/dashboard");
      if (!res.ok) {
        setError(`Could not load dashboard (HTTP ${res.status}).`);
        setData(null);
        return;
      }
      const body = (await res.json()) as DashboardResponse;
      setData(body);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function fmtMoney(n: number): string {
    if (!Number.isFinite(n)) return "$0";
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(0)}`;
  }

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: 24, color: "var(--wp-text, #fff)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4, gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, margin: 0 }} data-testid="sf-portal-title">
          Salesforce Portal
        </h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setCreateOpen("contacts")}
            style={primaryBtnStyle}
            data-testid="sf-portal-new-contact"
          >
            + New contact
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen("opportunities")}
            style={primaryBtnStyle}
            data-testid="sf-portal-new-opportunity"
          >
            + New opportunity
          </button>
        </div>
      </div>
      <p style={{ color: "var(--wp-text-dim, #a0a8b4)", marginBottom: 24 }}>
        Pipeline snapshot, recent activity, and a clickable drill-in for every record. Data flows through the same connector the chat assistant uses.
      </p>

      {loading && <p>Loading…</p>}
      {error && (
        <div role="alert" style={{ ...cardStyle, marginBottom: 16, borderColor: "var(--wp-red, #ef4444)" }}>
          <p style={{ color: "var(--wp-red, #ef4444)", margin: 0 }}>{error}</p>
        </div>
      )}

      {data?.notConfigured && (
        <section style={cardStyle} data-testid="sf-portal-cta">
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Connect Salesforce</h2>
          <p style={{ color: "var(--wp-text-dim, #a0a8b4)", marginTop: 0 }}>
            This workspace doesn&apos;t have an active Salesforce connector. Configure it once and every list, drill-in, and assistant tool starts pulling live data.
          </p>
          <Link
            href="/admin/connectors"
            style={ctaLinkStyle}
            data-testid="sf-portal-connect-link"
          >
            Go to /admin/connectors →
          </Link>
        </section>
      )}

      {data && !data.notConfigured && (
        <>
          <section style={{ ...cardStyle, marginBottom: 16 }} aria-label="pipeline-snapshot" data-testid="sf-pipeline-snapshot">
            <h2 style={{ fontSize: 18, marginTop: 0 }}>Pipeline snapshot</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Tile label="Open opportunities" value={String(data.pipeline.openCount)} />
              <Tile label="Pipeline $" value={fmtMoney(data.pipeline.totalAmount)} />
              <Tile label="Stages tracked" value={String(data.pipeline.byStage.length)} />
            </div>
            {data.pipeline.byStage.length > 0 && (
              <ul style={{ marginTop: 16, padding: 0, listStyle: "none" }} data-testid="sf-stage-breakdown">
                {data.pipeline.byStage.map((s) => (
                  <li
                    key={s.stage}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "6px 0",
                      borderBottom: "1px solid var(--wp-dark-border, #2a2c30)",
                      fontSize: 13,
                    }}
                  >
                    <span>{s.stage}</span>
                    <span style={{ color: "var(--wp-text-dim, #a0a8b4)" }}>
                      {s.count} · {fmtMoney(s.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ ...cardStyle, marginBottom: 16 }} aria-label="quick-links">
            <h2 style={{ fontSize: 18, marginTop: 0 }}>Quick links</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link href="/portal/salesforce/contacts" style={linkBtnStyle} data-testid="sf-link-contacts">
                Contacts
              </Link>
              <Link href="/portal/salesforce/opportunities" style={linkBtnStyle} data-testid="sf-link-opportunities">
                Opportunities
              </Link>
              <Link href="/portal/salesforce/accounts" style={linkBtnStyle} data-testid="sf-link-accounts">
                Accounts
              </Link>
              <button
                type="button"
                onClick={() => setCreateOpen("accounts")}
                style={linkBtnStyle}
                data-testid="sf-portal-new-account"
              >
                + New account
              </button>
            </div>
          </section>

          <section style={cardStyle} aria-label="recent-activity" data-testid="sf-recent-activity">
            <h2 style={{ fontSize: 18, marginTop: 0 }}>Recent activity</h2>
            {data.recent.length === 0 ? (
              <p style={{ color: "var(--wp-text-dim, #a0a8b4)" }}>No recently-modified records.</p>
            ) : (
              <ul style={{ padding: 0, listStyle: "none", margin: 0 }}>
                {data.recent.map((r) => (
                  <li
                    key={`${r.type}:${r.id}`}
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid var(--wp-dark-border, #2a2c30)",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <Link
                      href={`/portal/salesforce/${r.type}/${encodeURIComponent(r.id)}`}
                      style={{ color: "var(--wp-text, #fff)", textDecoration: "none", fontSize: 14 }}
                    >
                      <strong>{r.name}</strong>
                    </Link>
                    <span style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>
                      {r.type} · {r.lastModified ? new Date(r.lastModified).toLocaleString() : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {createOpen && (
        <SalesforceCreateModal
          open={true}
          type={createOpen}
          onClose={() => setCreateOpen(null)}
          onCreated={(id) => {
            setCreateOpen(null);
            router.push(`/portal/salesforce/${createOpen}/${encodeURIComponent(id)}`);
          }}
        />
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--wp-dark-surface2, #16181c)",
        border: "1px solid var(--wp-dark-border, #2a2c30)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface, #1c1e22)",
  border: "1px solid var(--wp-dark-border, #2a2c30)",
  borderRadius: 8,
  padding: 16,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark, #111)",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 13,
};

const linkBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--wp-dark-surface2, #16181c)",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-dark-border, #2a2c30)",
  borderRadius: 6,
  textDecoration: "none",
  fontSize: 13,
  cursor: "pointer",
};

const ctaLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark, #111)",
  borderRadius: 6,
  fontWeight: 600,
  textDecoration: "none",
};
