"use client";

/**
 * DomainManager — Instinct Sites custom-domain UI.
 *
 * Self-contained block for the site detail page. Accepts only a
 * `siteId` + optional `previewUrl` and owns the entire add/verify/
 * remove lifecycle against `/api/sites/[id]/domain`.
 *
 * UX:
 *   - Input + "Add domain" button.
 *   - List of attached domains with a status chip (pending / verified /
 *     removed / failed).
 *   - For `pending` domains, render the DNS verification records in a
 *     copy-pasteable block so the designer can hand them to the client.
 *   - Per-row "Refresh" pings PATCH action=refresh to re-poll Vercel.
 *   - Per-row "Remove" fires DELETE after a confirm dialog.
 *
 * Every API call goes through fetchWithRefresh (global CLAUDE.md rule —
 * raw fetch from a client component caused the April 16 blank-dashboard
 * incident).
 *
 * Accessibility: input has an explicit label, buttons have aria-labels,
 * status chips are role="status", the empty state uses
 * role="status" aria-live so the screen reader hears the initial "no
 * domains attached" hint without re-announcing on every poll.
 *
 * NOTE for the SEO agent: this component does NOT touch
 * `src/lib/sites-schema.ts` or any Seo/favicon file. The parent page
 * will import both agents' output side by side.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export interface DomainRecordView {
  id: string;
  site_id: string;
  domain: string;
  status: "pending" | "verified" | "removed" | "failed";
  verification_records: Array<{
    type: string;
    domain: string;
    value: string;
    reason?: string;
  }>;
  added_at: string;
  verified_at: string | null;
  removed_at: string | null;
  last_error: string | null;
}

interface Props {
  siteId: string;
  previewUrl: string | null;
}

const STATUS_STYLES: Record<DomainRecordView["status"], { bg: string; color: string; border: string; label: string }> = {
  pending: { bg: "rgba(255, 200, 80, 0.12)", color: "var(--wp-warning, #e6b84d)", border: "rgba(255, 200, 80, 0.4)", label: "Pending DNS" },
  verified: { bg: "rgba(80, 200, 120, 0.12)", color: "var(--wp-success, #6dcf85)", border: "rgba(80, 200, 120, 0.4)", label: "Verified" },
  removed: { bg: "rgba(200, 200, 200, 0.1)", color: "var(--wp-text-dim)", border: "var(--wp-border)", label: "Removed" },
  failed: { bg: "rgba(220, 80, 80, 0.12)", color: "var(--wp-error, #e07070)", border: "rgba(220, 80, 80, 0.4)", label: "Failed" },
};

export default function DomainManager({ siteId, previewUrl }: Props) {
  const [domains, setDomains] = useState<DomainRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${siteId}/domain`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? "Failed to load domains.");
        setDomains([]);
      } else {
        setDomains((data.domains ?? []) as DomainRecordView[]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = input.trim().toLowerCase();
    if (!domain) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${siteId}/domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? "Could not add domain.");
      } else {
        setMessage(
          data.status === "verified"
            ? `Verified ${domain} — live on this site.`
            : `Added ${domain}. Configure the DNS records below, then click Refresh.`,
        );
        setInput("");
        await load();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefresh(domain: string) {
    setBusyDomain(domain);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${siteId}/domain`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: "refresh" }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? "Refresh failed.");
      } else {
        await load();
      }
    } finally {
      setBusyDomain(null);
    }
  }

  async function handleRemove(domain: string) {
    if (!confirm(`Remove ${domain} from this site?\n\nThe DNS records will stop routing to Instinct.`)) return;
    setBusyDomain(domain);
    setError(null);
    try {
      const url = `/api/sites/${siteId}/domain?domain=${encodeURIComponent(domain)}`;
      const r = await fetchWithRefresh(url, { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? "Remove failed.");
      } else {
        setMessage(`${domain} removed.`);
        await load();
      }
    } finally {
      setBusyDomain(null);
    }
  }

  function copyValue(value: string) {
    navigator.clipboard.writeText(value).catch(() => {});
  }

  return (
    <section
      data-testid="domain-manager"
      style={{
        padding: "1rem",
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: "8px",
        color: "var(--wp-text)",
      }}
    >
      <div style={{ marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Custom domains</h3>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--wp-text-dim)" }}>
          Share a real branded URL with clients instead of the default preview link
          {previewUrl ? <> (<code>{previewUrl}</code>)</> : null}.
        </p>
      </div>

      <form onSubmit={handleAdd} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <label htmlFor={`domain-input-${siteId}`} style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}>
          Add a custom domain
        </label>
        <input
          id={`domain-input-${siteId}`}
          data-testid="domain-input"
          type="text"
          placeholder="example.com"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={submitting}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: "1 1 240px",
            padding: "0.55rem 0.75rem",
            background: "var(--wp-dark, #1b1b1b)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            fontSize: "0.9rem",
          }}
        />
        <button
          type="submit"
          data-testid="domain-add-button"
          disabled={submitting || !input.trim()}
          aria-label="Add domain"
          style={{
            padding: "0.55rem 1rem",
            background: "var(--wp-gold)",
            color: "var(--wp-dark, #1b1b1b)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: submitting ? "wait" : "pointer",
            fontSize: "0.85rem",
          }}
        >
          {submitting ? "Adding…" : "Add domain"}
        </button>
      </form>

      {error && (
        <div
          data-testid="domain-error"
          role="alert"
          style={{
            padding: "0.6rem 0.8rem",
            marginBottom: "0.6rem",
            background: "rgba(220, 80, 80, 0.08)",
            border: "1px solid rgba(220, 80, 80, 0.4)",
            color: "#e07070",
            borderRadius: "6px",
            fontSize: "0.82rem",
          }}
        >
          {error}
        </div>
      )}
      {message && (
        <div
          data-testid="domain-message"
          role="status"
          style={{
            padding: "0.6rem 0.8rem",
            marginBottom: "0.6rem",
            background: "rgba(80, 200, 120, 0.08)",
            border: "1px solid rgba(80, 200, 120, 0.4)",
            color: "var(--wp-success, #6dcf85)",
            borderRadius: "6px",
            fontSize: "0.82rem",
          }}
        >
          {message}
        </div>
      )}

      {loading ? (
        <div data-testid="domain-loading" style={{ fontSize: "0.82rem", color: "var(--wp-text-dim)" }}>
          Loading domains…
        </div>
      ) : domains.length === 0 ? (
        <div
          data-testid="domain-empty-state"
          role="status"
          aria-live="polite"
          style={{
            padding: "0.9rem 1rem",
            background: "rgba(80, 140, 220, 0.06)",
            border: "1px dashed var(--wp-border)",
            borderRadius: "6px",
            fontSize: "0.85rem",
            color: "var(--wp-text-dim)",
          }}
        >
          No custom domains yet. Add one above to give clients a branded URL.
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }} data-testid="domain-list">
          {domains.map((d) => {
            const chip = STATUS_STYLES[d.status];
            const isBusy = busyDomain === d.domain;
            return (
              <li
                key={d.id}
                data-testid={`domain-row-${d.domain}`}
                style={{
                  padding: "0.75rem 0.85rem",
                  background: "var(--wp-dark, #1b1b1b)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                    <code style={{ fontSize: "0.9rem", color: "var(--wp-text)" }}>{d.domain}</code>
                    <span
                      role="status"
                      data-testid={`domain-status-${d.domain}`}
                      style={{
                        padding: "0.15rem 0.55rem",
                        background: chip.bg,
                        color: chip.color,
                        border: `1px solid ${chip.border}`,
                        borderRadius: "999px",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                      }}
                    >
                      {chip.label}
                    </span>
                  </div>
                  {d.status !== "removed" && (
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button
                        type="button"
                        onClick={() => handleRefresh(d.domain)}
                        disabled={isBusy}
                        aria-label={`Refresh ${d.domain} status`}
                        data-testid={`domain-refresh-${d.domain}`}
                        style={buttonStyle()}
                      >
                        {isBusy ? "…" : "Refresh"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(d.domain)}
                        disabled={isBusy}
                        aria-label={`Remove ${d.domain}`}
                        data-testid={`domain-remove-${d.domain}`}
                        style={buttonStyle("error")}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                {d.status === "pending" && d.verification_records.length > 0 && (
                  <div
                    data-testid={`domain-verification-${d.domain}`}
                    style={{
                      marginTop: "0.65rem",
                      padding: "0.55rem 0.7rem",
                      background: "var(--wp-card)",
                      border: "1px solid var(--wp-border)",
                      borderRadius: "6px",
                      fontSize: "0.78rem",
                      color: "var(--wp-text-dim)",
                    }}
                  >
                    <div style={{ marginBottom: "0.3rem", fontWeight: 600, color: "var(--wp-text)" }}>
                      Add these DNS records at your registrar:
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      {d.verification_records.map((v, idx) => (
                        <li key={idx} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "0.5rem", alignItems: "center" }}>
                          <code style={{ color: "var(--wp-gold)" }}>{v.type}</code>
                          <code style={{ wordBreak: "break-all", color: "var(--wp-text)" }}>
                            {v.domain} → {v.value}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyValue(`${v.type} ${v.domain} ${v.value}`)}
                            aria-label={`Copy DNS ${v.type} record for ${v.domain}`}
                            style={buttonStyle()}
                          >
                            Copy
                          </button>
                        </li>
                      ))}
                    </ul>
                    {d.verification_records.some((v) => v.reason) && (
                      <div style={{ marginTop: "0.35rem", color: "var(--wp-warning, #e6b84d)" }}>
                        {d.verification_records.find((v) => v.reason)?.reason}
                      </div>
                    )}
                  </div>
                )}

                {d.status === "failed" && d.last_error && (
                  <div style={{ marginTop: "0.5rem", fontSize: "0.78rem", color: "var(--wp-error, #e07070)" }}>
                    {d.last_error}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function buttonStyle(tone: "default" | "error" = "default"): React.CSSProperties {
  const isError = tone === "error";
  return {
    padding: "0.35rem 0.7rem",
    background: "transparent",
    color: isError ? "var(--wp-error, #e07070)" : "var(--wp-text)",
    border: `1px solid ${isError ? "rgba(220, 80, 80, 0.4)" : "var(--wp-border)"}`,
    borderRadius: "6px",
    fontSize: "0.75rem",
    cursor: "pointer",
    fontWeight: 500,
  };
}
