"use client";

/**
 * SharePanel — Instinct Sites designer-facing share-link + approval UI.
 *
 * Imported by `src/app/(dashboard)/sites/[id]/page.tsx` (left to the
 * parent session — this wave only adds the component). Self-contained:
 * takes `siteId` + `previewUrl`, owns the entire lifecycle against
 * `/api/sites/[id]/share`.
 *
 * UX:
 *   - Latest approval state chip (approved / changes_requested /
 *     pending / none) rendered prominently.
 *   - "Generate share link" button → POST, writes the returned URL
 *     to the clipboard, shows a "Copied" toast.
 *   - Active + historical share tokens listed with expiry + access
 *     count + a revoke button.
 *   - Every fetch goes through fetchWithRefresh (CLAUDE.md rule).
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

type ApprovalState = "pending" | "approved" | "changes_requested";

interface LatestApproval {
  state: ApprovalState;
  actorName: string | null;
  actorEmail: string | null;
  comment: string | null;
  createdAt: string;
  viaShareToken: boolean;
}

interface ShareTokenView {
  id: string;
  nonce: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

interface Props {
  siteId: string;
  previewUrl: string | null;
}

const STATE_STYLES: Record<ApprovalState | "none", { bg: string; border: string; color: string; label: string }> = {
  approved: {
    bg: "rgba(80, 200, 120, 0.12)",
    border: "rgba(80, 200, 120, 0.4)",
    color: "var(--wp-success, #6dcf85)",
    label: "Client approved",
  },
  changes_requested: {
    bg: "rgba(255, 200, 80, 0.12)",
    border: "rgba(255, 200, 80, 0.4)",
    color: "var(--wp-warning, #e6b84d)",
    label: "Changes requested",
  },
  pending: {
    bg: "rgba(120, 160, 255, 0.12)",
    border: "rgba(120, 160, 255, 0.4)",
    color: "var(--wp-info, #88abff)",
    label: "Awaiting review",
  },
  none: {
    bg: "rgba(200, 200, 200, 0.1)",
    border: "var(--wp-border)",
    color: "var(--wp-text-dim)",
    label: "Not sent yet",
  },
};

export default function SharePanel({ siteId, previewUrl }: Props) {
  const [tokens, setTokens] = useState<ShareTokenView[]>([]);
  const [latestApproval, setLatestApproval] = useState<LatestApproval | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/sites/${siteId}/share`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Failed to load share links.");
        setTokens([]);
        setLatestApproval(null);
        return;
      }
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      setLatestApproval(data.latestApproval ?? null);
    } catch (err) {
      setError((err as Error).message || "Network error.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generateLink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/sites/${siteId}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not generate link.");
        return;
      }
      const fullUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}${data.shareUrl}`
          : data.shareUrl;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(fullUrl);
          setFlash("Copied to clipboard");
        } else {
          setFlash(fullUrl);
        }
      } catch {
        setFlash(fullUrl);
      }
      await load();
    } catch (err) {
      setError((err as Error).message || "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: string) {
    const ok =
      typeof window !== "undefined"
        ? window.confirm("Revoke this share link? The client will lose access immediately.")
        : true;
    if (!ok) return;
    setRevoking(tokenId);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/sites/${siteId}/share?tokenId=${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data?.error === "string" ? data.error : "Revoke failed.");
        return;
      }
      await load();
    } finally {
      setRevoking(null);
    }
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const stateKey: ApprovalState | "none" = latestApproval?.state ?? "none";
  const stateStyle = STATE_STYLES[stateKey];

  return (
    <section
      data-testid="share-panel"
      aria-label="Client share and approvals"
      style={{
        border: "1px solid var(--wp-border, #222)",
        borderRadius: 8,
        padding: 16,
        marginTop: 16,
        background: "var(--wp-panel, #111)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Client share &amp; approval</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--wp-text-dim)" }}>
            Send the client a preview URL without making them log in. Their
            approval is recorded and timestamped.
          </p>
        </div>
        <div
          data-testid="approval-state-chip"
          role="status"
          style={{
            padding: "4px 10px",
            borderRadius: 12,
            background: stateStyle.bg,
            border: `1px solid ${stateStyle.border}`,
            color: stateStyle.color,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {stateStyle.label}
        </div>
      </div>

      {latestApproval?.comment && (
        <blockquote
          data-testid="latest-approval-comment"
          style={{
            marginTop: 12,
            padding: 10,
            background: "var(--wp-panel-subtle, rgba(255,255,255,0.04))",
            borderLeft: "3px solid var(--wp-border)",
            fontSize: 13,
            color: "var(--wp-text)",
          }}
        >
          &ldquo;{latestApproval.comment}&rdquo;
          <div style={{ fontSize: 11, color: "var(--wp-text-dim)", marginTop: 4 }}>
            {latestApproval.actorName || "Anonymous reviewer"} ·{" "}
            {new Date(latestApproval.createdAt).toLocaleString()}
          </div>
        </blockquote>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          data-testid="generate-share-link"
          type="button"
          onClick={generateLink}
          disabled={busy || !previewUrl}
          style={{
            padding: "8px 16px",
            borderRadius: 4,
            background: "var(--wp-accent, #3070ff)",
            color: "white",
            border: "none",
            cursor: busy || !previewUrl ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 500,
            opacity: busy || !previewUrl ? 0.6 : 1,
          }}
          aria-label="Generate a new share link for this site"
        >
          {busy ? "Generating…" : "Generate share link"}
        </button>
        {!previewUrl && (
          <span
            data-testid="no-preview-hint"
            style={{ fontSize: 12, color: "var(--wp-text-dim)" }}
          >
            Deploy the site first to generate a share link.
          </span>
        )}
        {flash && (
          <span
            data-testid="share-flash"
            role="status"
            aria-live="polite"
            style={{ fontSize: 12, color: "var(--wp-success, #6dcf85)" }}
          >
            {flash}
          </span>
        )}
      </div>

      {error && (
        <div
          data-testid="share-error"
          role="alert"
          style={{ marginTop: 8, fontSize: 12, color: "var(--wp-error, #e07070)" }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <h4 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--wp-text)" }}>
          Active share links
        </h4>
        {loading ? (
          <div data-testid="share-loading" style={{ fontSize: 12, color: "var(--wp-text-dim)" }}>
            Loading…
          </div>
        ) : tokens.length === 0 ? (
          <div
            data-testid="share-empty-state"
            role="status"
            aria-live="polite"
            style={{ fontSize: 12, color: "var(--wp-text-dim)" }}
          >
            No share links issued yet.
          </div>
        ) : (
          <ul
            data-testid="share-token-list"
            style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}
          >
            {tokens.map((t) => {
              const revoked = Boolean(t.revoked_at);
              const expired = new Date(t.expires_at).getTime() <= Date.now();
              const status = revoked ? "Revoked" : expired ? "Expired" : "Active";
              return (
                <li
                  key={t.id}
                  data-testid={`share-token-row-${t.id}`}
                  data-status={status.toLowerCase()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    border: "1px solid var(--wp-border)",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "var(--wp-text)",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span>
                      <strong>{status}</strong> · expires{" "}
                      {new Date(t.expires_at).toLocaleDateString()}
                    </span>
                    <span style={{ color: "var(--wp-text-dim)" }}>
                      {t.access_count} view{t.access_count === 1 ? "" : "s"}
                      {t.last_accessed_at
                        ? ` · last viewed ${new Date(t.last_accessed_at).toLocaleString()}`
                        : " · never viewed"}
                    </span>
                  </div>
                  {!revoked && !expired && (
                    <button
                      data-testid={`revoke-token-${t.id}`}
                      type="button"
                      onClick={() => revokeToken(t.id)}
                      disabled={revoking === t.id}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 4,
                        background: "transparent",
                        border: "1px solid var(--wp-border)",
                        color: "var(--wp-text)",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                      aria-label="Revoke this share link"
                    >
                      {revoking === t.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
