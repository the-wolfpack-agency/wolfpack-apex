"use client";

/**
 * /admin/connectors/github-app - link a per-client GitHub App installation.
 *
 * CTO/CEO only (enforced by /api/admin/connectors/github-app). This is the
 * per-client alternative to the single shared org PAT: a client installs our
 * GitHub App on the specific repos they choose, and we mint a short-lived
 * installation token scoped to JUST their installation for scans + remediation
 * PRs. If the App isn't configured or the workspace hasn't linked one, scans
 * fall back to the existing PAT - surfaced explicitly here so there's never a
 * silent blank state.
 *
 * Theme via var(--wp-*) tokens (mirrors the sibling connectors page). All
 * authenticated fetches go through fetchWithRefresh.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface InstallationRow {
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  linkedAt: string;
  linkedBy: string;
}

interface StatusResponse {
  configured: boolean;
  patConfigured: boolean;
  installation: InstallationRow | null;
  fallback: "installation" | "pat" | "none";
}

const INSTALL_APP_URL = process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL || "";

export default function GithubAppConnectorPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [accountLogin, setAccountLogin] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/connectors/github-app");
      if (!res.ok) {
        setError(`Could not load GitHub App status (HTTP ${res.status}).`);
        setStatus(null);
        return;
      }
      const data = (await res.json()) as StatusResponse;
      setStatus(data);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* Surface the install-callback redirect (?github_app_connected /
     ?github_app_error) as a toast, then clear it from the URL. */
  useEffect(() => {
    const connected = searchParams.get("github_app_connected");
    const appError = searchParams.get("github_app_error");
    if (connected) {
      setOkMessage(
        `Installed and linked (installation ${connected}). Client repos are now reachable via a scoped installation token.`,
      );
      router.replace(pathname);
    } else if (appError) {
      setError(`GitHub App install failed (${appError}).`);
      router.replace(pathname);
    }
  }, [searchParams, router, pathname]);

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    setOkMessage(null);
    try {
      const res = await fetchWithRefresh("/api/admin/connectors/github-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: installationId.trim(),
          ...(accountLogin.trim() ? { accountLogin: accountLogin.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `HTTP ${res.status}`);
        return;
      }
      setOkMessage("Linked. Scans and remediation PRs for this client now use a scoped installation token.");
      setInstallationId("");
      setAccountLogin("");
      await load();
    } catch (e) {
      setError((e as Error).message || "Link failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function onUnlink() {
    if (!confirm("Unlink this GitHub App installation? Scans will fall back to the shared PAT.")) {
      return;
    }
    setError(null);
    setOkMessage(null);
    const res = await fetchWithRefresh("/api/admin/connectors/github-app", {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Unlink failed (HTTP ${res.status})`);
      return;
    }
    setOkMessage("Unlinked. Falling back to the shared PAT for this workspace.");
    await load();
  }

  function fallbackBadge(fallback: StatusResponse["fallback"]) {
    if (fallback === "installation") {
      return (
        <span data-testid="fallback-badge" style={badgeOkStyle}>
          Scoped installation token
        </span>
      );
    }
    if (fallback === "pat") {
      return (
        <span data-testid="fallback-badge" style={badgeWarnStyle}>
          Falling back to shared PAT
        </span>
      );
    }
    return (
      <span data-testid="fallback-badge" style={badgeErrStyle}>
        No GitHub token available
      </span>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 24, color: "var(--wp-text,#fff)" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>GitHub App (per-client repo access)</h1>
      <p style={{ color: "var(--wp-text-dim,#a0a8b4)", marginBottom: 24 }}>
        Let a client grant access to just the repos they choose by installing our
        GitHub App. We mint a short-lived token scoped to that installation for
        scans and remediation PRs - no single shared credential that can reach
        every client. When no installation is linked, we fall back to the shared
        agency PAT.
      </p>

      {okMessage && (
        <div role="status" style={{ ...cardStyle, marginBottom: 16, borderColor: "var(--wp-green,#22c55e)" }}>
          <p style={{ color: "var(--wp-green,#22c55e)", margin: 0 }}>{okMessage}</p>
        </div>
      )}
      {error && (
        <div role="alert" style={{ ...cardStyle, marginBottom: 16, borderColor: "var(--wp-red,#ef4444)" }}>
          <p style={{ color: "var(--wp-red,#ef4444)", margin: 0 }}>{error}</p>
        </div>
      )}

      <section style={cardStyle} aria-label="github-app-status">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Status</h2>
        {loading && <p data-testid="ga-loading">Loading…</p>}
        {!loading && status && (
          <div style={{ fontSize: 14, lineHeight: 1.8 }}>
            <div>
              GitHub App configured:{" "}
              <strong data-testid="ga-configured">{status.configured ? "yes" : "no"}</strong>
              {!status.configured && (
                <span style={{ color: "var(--wp-text-dim,#a0a8b4)" }}>
                  {" "}
                  (set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY to enable per-client tokens)
                </span>
              )}
            </div>
            <div>
              Active token for scans: {fallbackBadge(status.fallback)}
            </div>
            {status.installation ? (
              <div data-testid="ga-installation" style={{ marginTop: 8 }}>
                Linked installation <code>{status.installation.installationId}</code>
                {status.installation.accountLogin
                  ? ` on ${status.installation.accountLogin}`
                  : ""}{" "}
                · linked {new Date(status.installation.linkedAt).toLocaleString()}
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={onUnlink} style={{ ...smallBtnStyle, color: "var(--wp-red,#ef4444)" }}>
                    Unlink
                  </button>
                </div>
              </div>
            ) : (
              <div data-testid="ga-no-installation" style={{ marginTop: 8, color: "var(--wp-text-dim,#a0a8b4)" }}>
                No installation linked for this workspace - using the shared PAT.
              </div>
            )}
          </div>
        )}
        {!loading && !status && (
          <p style={{ color: "var(--wp-text-dim,#a0a8b4)" }}>Status unavailable.</p>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 24 }} aria-label="github-app-install">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Install GitHub App</h2>
        <p style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 0, marginBottom: 16 }}>
          Send the client to install the App on their repos. GitHub redirects
          back here and links the installation automatically.
        </p>
        {INSTALL_APP_URL ? (
          <a href={INSTALL_APP_URL} style={{ ...oauthBtnStyle, textDecoration: "none", display: "inline-block" }}>
            Install GitHub App
          </a>
        ) : (
          <p style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)" }}>
            Set <code>NEXT_PUBLIC_GITHUB_APP_INSTALL_URL</code> to enable the
            one-click install button, or link an existing installation id below.
          </p>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 24 }} aria-label="github-app-manual">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Link an installation id</h2>
        <p style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 0, marginBottom: 12 }}>
          If the client already installed the App, paste the numeric installation
          id (visible in the App installation settings URL) to link it to this
          workspace.
        </p>
        <form onSubmit={onSubmit} aria-label="github-app-link-form">
          <label style={labelStyle}>
            Installation id
            <input
              type="text"
              inputMode="numeric"
              placeholder="12345678"
              value={installationId}
              onChange={(e) => setInstallationId(e.target.value)}
              style={inputStyle}
              required
              data-testid="ga-installation-id"
            />
          </label>
          <label style={labelStyle}>
            Account login (optional)
            <input
              type="text"
              placeholder="acme-corp"
              value={accountLogin}
              onChange={(e) => setAccountLogin(e.target.value)}
              style={inputStyle}
              data-testid="ga-account-login"
            />
          </label>
          <button
            type="submit"
            data-testid="ga-submit"
            disabled={submitting || !installationId.trim()}
            style={{
              padding: "8px 16px",
              background: "var(--wp-gold,#eab308)",
              color: "#111",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Linking…" : "Link installation"}
          </button>
        </form>
      </section>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface,#1c1e22)",
  border: "1px solid var(--wp-dark-border,#2a2c30)",
  borderRadius: 8,
  padding: 16,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  marginBottom: 12,
  color: "var(--wp-text-dim,#a0a8b4)",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  background: "var(--wp-dark-surface2,#16181c)",
  color: "var(--wp-text,#fff)",
  border: "1px solid var(--wp-dark-border,#2a2c30)",
  borderRadius: 6,
};

const oauthBtnStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--wp-gold,#eab308)",
  color: "#111",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  cursor: "pointer",
};

const smallBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  color: "var(--wp-text,#fff)",
  border: "1px solid var(--wp-dark-border,#2a2c30)",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
};

const badgeOkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  marginLeft: 4,
  background: "rgba(34,197,94,0.15)",
  color: "var(--wp-green,#22c55e)",
  border: "1px solid rgba(34,197,94,0.4)",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
};

const badgeWarnStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  marginLeft: 4,
  background: "rgba(234,179,8,0.15)",
  color: "var(--wp-gold,#eab308)",
  border: "1px solid rgba(234,179,8,0.4)",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
};

const badgeErrStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  marginLeft: 4,
  background: "rgba(239,68,68,0.15)",
  color: "var(--wp-red,#ef4444)",
  border: "1px solid rgba(239,68,68,0.4)",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
};
