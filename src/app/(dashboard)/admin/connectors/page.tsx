"use client";

/**
 * /admin/connectors — manage per-tenant connector credentials.
 *
 * CTO/CEO only (enforced by the underlying APIs). Three layers:
 *
 *   1. Quick Connect — one-click OAuth for vendors with registered
 *      providers (Salesforce, HubSpot today; QBO/Jira/GitHub when
 *      their providers land). Kicks off /api/admin/connectors/oauth/
 *      <provider>/start which redirects to the vendor's authorize URL.
 *
 *   2. Active connectors — per-row badge ("OAuth" vs "Static bearer"),
 *      token-expiry hint for OAuth rows, and Verify + Disconnect
 *      actions.
 *
 *   3. Advanced — paste credentials manually. Still required for the
 *      generic rest-default connector and for clients who can't allow
 *      a 3rd-party OAuth app and must use their own static token.
 *
 * Auth headers are encrypted at rest (AES-256-GCM) and never re-rendered
 * in plaintext anywhere.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface MaskedConnectorRow {
  workspaceId: string;
  connectorName: string;
  baseUrl: string;
  authHeaderHint: string;
  objectMap?: Record<string, string>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  authType: "static_bearer" | "oauth2";
  accessTokenExpiresAt: string | null;
}

const VENDOR_OPTIONS = [
  {
    value: "rest-default",
    label: "rest-default — generic REST",
    baseUrl: "",
    objectMap: "",
    help: "Any client's REST API. Provide baseUrl + auth header.",
  },
  {
    value: "hubspot",
    label: "HubSpot CRM",
    baseUrl: "https://api.hubapi.com",
    objectMap: JSON.stringify(
      {
        contact: "crm/v3/objects/contacts",
        deal: "crm/v3/objects/deals",
        company: "crm/v3/objects/companies",
        ticket: "crm/v3/objects/tickets",
      },
      null,
      2,
    ),
    help: "Auth header: 'Bearer <private-app-token>' (HubSpot settings → integrations → private apps).",
  },
  {
    value: "salesforce",
    label: "Salesforce",
    baseUrl: "",
    objectMap: JSON.stringify(
      {
        contact: "services/data/v59.0/sobjects/Contact",
        deal: "services/data/v59.0/sobjects/Opportunity",
        company: "services/data/v59.0/sobjects/Account",
      },
      null,
      2,
    ),
    help: "baseUrl is your org URL (https://<instance>.my.salesforce.com). Auth: 'Bearer <oauth-token>'.",
  },
  {
    value: "quickbooks",
    label: "QuickBooks Online",
    baseUrl: "https://quickbooks.api.intuit.com",
    objectMap: JSON.stringify(
      {
        invoice: "v3/company/REALM_ID/invoice",
        payment: "v3/company/REALM_ID/payment",
        customer: "v3/company/REALM_ID/customer",
      },
      null,
      2,
    ),
    help: "Replace REALM_ID with the company realm id. Sandbox base: https://sandbox-quickbooks.api.intuit.com.",
  },
];

/** Vendors that support one-click OAuth. Each must have an OAuthProvider
 *  registered in src/lib/assistant/connectors/oauth/registry.ts. */
const OAUTH_VENDORS = [
  { name: "salesforce", label: "Salesforce" },
  { name: "hubspot", label: "HubSpot" },
];

export default function AdminConnectorsPage() {
  const [rows, setRows] = useState<MaskedConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<Record<string, string | null>>({});

  const [vendor, setVendor] = useState("rest-default");
  /* Custom connector name for manual (form-login / oauth-password) connections.
     The scanner resolves credentials by the EXACT connector name a scan target
     expects (a curated manifest's login.connectorName, or a client's platform id
     like "wolfpack-beyond" / "acme-crm"), so the operator must be able to name it
     to match. The vendor dropdown only offers "rest-default", which never matches
     a target. Empty falls back to the vendor value (static_bearer keeps using it). */
  const [connectorNameInput, setConnectorNameInput] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<"static_bearer" | "username_password" | "oauth_password" | "nextauth_credentials">("static_bearer");
  const [authHeader, setAuthHeader] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginPath, setLoginPath] = useState("");
  const [sessionCookieName, setSessionCookieName] = useState("");
  /* OAuth Resource-Owner-Password (e.g. a Salesforce sandbox): the operator
     pastes the connected-app consumer key/secret plus the user login. baseUrl is
     reused as the LOGIN url and loginPath as the token path. */
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [objectMapText, setObjectMapText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const selected = useMemo(
    () => VENDOR_OPTIONS.find((o) => o.value === vendor) ?? VENDOR_OPTIONS[0],
    [vendor],
  );

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/connectors");
      if (!res.ok) {
        setError(`Could not load connectors (HTTP ${res.status}).`);
        setRows([]);
        return;
      }
      const data = (await res.json()) as { connectors: MaskedConnectorRow[] };
      setRows((data.connectors ?? []).filter((r) => r.isActive));
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  /* Surface OAuth callback redirects to the user as success/error toasts.
     The callback route appends ?oauth_connected=<provider> on success
     and ?oauth_error=<code>&oauth_message=<text> on failure. We read
     them once + clear them from the URL so a reload doesn't re-toast. */
  useEffect(() => {
    const connected = searchParams.get("oauth_connected");
    const oauthError = searchParams.get("oauth_error");
    const oauthMessage = searchParams.get("oauth_message");
    if (connected) {
      setOkMessage(`✅ Connected ${connected}. Tokens stored encrypted; the assistant can query this CRM now.`);
      router.replace(pathname);
    } else if (oauthError) {
      setError(`OAuth failed (${oauthError})${oauthMessage ? `: ${oauthMessage}` : ""}`);
      router.replace(pathname);
    }
  }, [searchParams, router, pathname]);

  /* When the operator picks a vendor preset, prefill the URL +
     objectMap fields so they only have to type the auth header. */
  useEffect(() => {
    setBaseUrl(selected.baseUrl);
    setObjectMapText(selected.objectMap);
  }, [selected]);

  function startOAuth(provider: string): void {
    /* Full-page navigation (NOT fetch) — we need the browser to follow
       redirects from /start → vendor authorize → /callback → here. */
    window.location.href = `/api/admin/connectors/oauth/${encodeURIComponent(provider)}/start?return_to=${encodeURIComponent("/admin/connectors")}`;
  }

  async function disconnect(connectorName: string): Promise<void> {
    if (!confirm(`Disconnect ${connectorName}? Stored tokens will be deactivated. You can reconnect any time.`)) return;
    setError(null);
    setOkMessage(null);
    const res = await fetchWithRefresh(`/api/admin/connectors/${encodeURIComponent(connectorName)}/disconnect`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Disconnect failed (HTTP ${res.status})`);
      return;
    }
    setOkMessage(`Disconnected ${connectorName}.`);
    await loadRows();
  }

  async function verify(connectorName: string): Promise<void> {
    setVerifyState((s) => ({ ...s, [connectorName]: "checking…" }));
    const res = await fetchWithRefresh(`/api/admin/connectors/${encodeURIComponent(connectorName)}/verify`, {
      method: "POST",
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok) {
      setVerifyState((s) => ({
        ...s,
        [connectorName]: `✅ live (${body.duration_ms ?? "?"}ms${typeof body.matched === "number" ? `, ${body.matched} probe match` : ""})`,
      }));
    } else {
      setVerifyState((s) => ({
        ...s,
        [connectorName]: `⚠️ ${body?.code ?? "failed"}${body?.message ? `: ${body.message}` : ""}`,
      }));
    }
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    setOkMessage(null);
    try {
      let objectMap: Record<string, string> | undefined;
      if (objectMapText.trim().length > 0) {
        try {
          const parsed = JSON.parse(objectMapText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            objectMap = parsed as Record<string, string>;
          } else {
            throw new Error("objectMap JSON must be an object");
          }
        } catch (e) {
          setError(`objectMap is not valid JSON: ${(e as Error).message}`);
          setSubmitting(false);
          return;
        }
      }

      // Manual (form-login / oauth-password) connections must be named to match
      // the scan target the scanner resolves credentials by. static_bearer keeps
      // using the vendor preset name.
      const isManual =
        authType === "username_password" ||
        authType === "oauth_password" ||
        authType === "nextauth_credentials";
      const effectiveName = isManual ? connectorNameInput.trim() : vendor;
      if (isManual && effectiveName.length === 0) {
        setError("Connector name is required and must match the scan target id (e.g. wolfpack-beyond).");
        setSubmitting(false);
        return;
      }

      let payload: Record<string, unknown>;
      if (authType === "oauth_password") {
        payload = {
          connectorName: effectiveName,
          baseUrl,
          authType: "oauth_password" as const,
          clientId,
          clientSecret,
          username,
          password,
          loginPath,
          objectMap,
        };
      } else if (
        authType === "username_password" ||
        authType === "nextauth_credentials"
      ) {
        payload = {
          connectorName: effectiveName,
          baseUrl,
          authType,
          username,
          password,
          loginPath,
          ...(sessionCookieName.trim().length > 0
            ? { sessionCookieName: sessionCookieName.trim() }
            : {}),
          objectMap,
        };
      } else {
        payload = {
          connectorName: effectiveName,
          baseUrl,
          authHeader,
          objectMap,
        };
      }

      const res = await fetchWithRefresh("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `HTTP ${res.status}`);
        return;
      }
      setOkMessage(`Saved ${effectiveName}. Tools using this connector will pick up the new credentials immediately.`);
      setAuthHeader(""); // never keep plaintext in the form
      setPassword(""); // never keep plaintext in the form
      setClientSecret(""); // never keep plaintext in the form
      await loadRows();
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  function renderExpiry(row: MaskedConnectorRow): string {
    if (row.authType !== "oauth2" || !row.accessTokenExpiresAt) return "";
    const ms = Date.parse(row.accessTokenExpiresAt);
    if (Number.isNaN(ms)) return "";
    const minsLeft = Math.round((ms - Date.now()) / 60000);
    if (minsLeft < 0) return ` · access token expired ${-minsLeft}m ago (will auto-refresh on next call)`;
    if (minsLeft < 60) return ` · access token expires in ${minsLeft}m`;
    const hoursLeft = Math.round(minsLeft / 60);
    return ` · access token expires in ${hoursLeft}h`;
  }

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: 24, color: "var(--wp-text,#fff)" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Connectors</h1>
      <p style={{ color: "var(--wp-text-dim,#a0a8b4)", marginBottom: 24 }}>
        External-system credentials used by Assistant tools. Auth headers are
        encrypted at rest (AES-256-GCM) and never re-rendered in plaintext.
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

      <section style={cardStyle} aria-label="quick-connect">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Quick Connect</h2>
        <p style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 0, marginBottom: 16 }}>
          One-click OAuth. The vendor signs the user in, asks for permission, and
          drops back here. We never see the password.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {OAUTH_VENDORS.map((v) => (
            <button
              key={v.name}
              type="button"
              onClick={() => startOAuth(v.name)}
              style={oauthBtnStyle}
            >
              Connect {v.label}
            </button>
          ))}
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 24 }} aria-label="active-connectors">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Active connectors</h2>
        {loading && <p>Loading…</p>}
        {!loading && rows.length === 0 && (
          <p style={{ color: "var(--wp-text-dim,#a0a8b4)" }}>None configured yet.</p>
        )}
        {rows.map((r) => (
          <div
            key={`${r.workspaceId}:${r.connectorName}`}
            style={{
              padding: 12,
              borderBottom: "1px solid var(--wp-dark-border,#2a2c30)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <strong style={{ fontSize: 15 }}>
                {r.connectorName}{" "}
                <span style={r.authType === "oauth2" ? badgeOauthStyle : badgeStaticStyle}>
                  {r.authType === "oauth2" ? "OAuth" : "Static bearer"}
                </span>
              </strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => verify(r.connectorName)} style={smallBtnStyle}>
                  Verify
                </button>
                <button
                  type="button"
                  onClick={() => disconnect(r.connectorName)}
                  style={{ ...smallBtnStyle, color: "var(--wp-red,#ef4444)" }}
                >
                  Disconnect
                </button>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 6 }}>
              <div>baseUrl: {r.baseUrl || "(none)"}</div>
              <div>
                auth: <code>{r.authHeaderHint}</code>
                {renderExpiry(r)}
              </div>
              {r.objectMap && <div>objects: {Object.keys(r.objectMap).join(", ")}</div>}
              <div>updated {new Date(r.updatedAt).toLocaleString()}</div>
              {verifyState[r.connectorName] && (
                <div style={{ marginTop: 4 }}>verify: {verifyState[r.connectorName]}</div>
              )}
            </div>
          </div>
        ))}
      </section>

      <section style={{ ...cardStyle, marginTop: 24 }} aria-label="advanced-static-form">
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Advanced — paste static credentials</h2>
        <p style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 0, marginBottom: 12 }}>
          For the generic <code>rest-default</code> connector and for clients who
          can&apos;t allow a 3rd-party OAuth app. Use Quick Connect above for
          one-click Salesforce / HubSpot whenever possible.
        </p>
        <form onSubmit={onSubmit} aria-label="connector-form">
          <label style={labelStyle}>
            Vendor
            <select value={vendor} onChange={(e) => setVendor(e.target.value)} style={inputStyle}>
              {VENDOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <p style={{ fontSize: 12, color: "var(--wp-text-dim,#a0a8b4)", marginTop: -8, marginBottom: 12 }}>
            {selected.help}
          </p>

          <label style={labelStyle}>
            Auth type
            <select
              data-testid="conn-auth-type"
              value={authType}
              onChange={(e) => {
                const next = e.target.value as "static_bearer" | "username_password" | "oauth_password" | "nextauth_credentials";
                setAuthType(next);
                /* OAuth password defaults the token path to Salesforce's, and
                   NextAuth defaults the credentials-callback path, so the
                   operator only types it to override; leaving the other modes
                   alone so a stale default path is not posted. */
                if (next === "oauth_password" && loginPath.trim().length === 0) {
                  setLoginPath("/services/oauth2/token");
                }
                if (next === "nextauth_credentials" && loginPath.trim().length === 0) {
                  setLoginPath("/api/auth/callback/credentials");
                }
              }}
              style={inputStyle}
            >
              <option value="static_bearer">Bearer token</option>
              <option value="username_password">Username &amp; password</option>
              <option value="oauth_password">OAuth password (Salesforce)</option>
              <option value="nextauth_credentials">NextAuth / Auth.js (credentials)</option>
            </select>
          </label>

          {(authType === "username_password" ||
            authType === "oauth_password" ||
            authType === "nextauth_credentials") && (
            <label style={labelStyle}>
              Connector name
              <input
                type="text"
                placeholder="wolfpack-beyond (must match the scan target id)"
                value={connectorNameInput}
                onChange={(e) => setConnectorNameInput(e.target.value)}
                style={inputStyle}
                autoComplete="off"
                data-testid="conn-name"
              />
              <span style={{ fontSize: 12, color: "var(--wp-text-dim,#a0a8b4)" }}>
                Must exactly match the target the scanner authenticates (a curated
                manifest connector name, or the onboarded platform id).
              </span>
            </label>
          )}

          <label style={labelStyle}>
            Base URL
            <input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              style={inputStyle}
              required
              data-testid="conn-base-url"
            />
          </label>

          {authType === "static_bearer" && (
            <label style={labelStyle}>
              Auth header
              <input
                type="password"
                placeholder="Bearer <token>"
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
                style={inputStyle}
                required
                autoComplete="off"
                data-testid="conn-auth-header"
              />
            </label>
          )}

          {(authType === "username_password" || authType === "nextauth_credentials") && (
            <>
              <p style={{ fontSize: 12, color: "var(--wp-text-dim,#a0a8b4)", marginTop: -4, marginBottom: 12 }}>
                {authType === "nextauth_credentials"
                  ? "For client platforms built on NextAuth.js / Auth.js (e.g. wolfpack-auto). We fetch a CSRF token, then POST these credentials to the credentials callback and store the returned session cookie, encrypted at rest."
                  : "For client platforms that use form login (e.g. Beyond). We POST these credentials to the login path and store the returned session cookie, encrypted at rest."}
              </p>
              <label style={labelStyle}>
                Username or email
                <input
                  type="text"
                  placeholder="admin@example.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-username"
                />
              </label>
              <label style={labelStyle}>
                Password
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-password"
                />
              </label>
              <label style={labelStyle}>
                Login path
                <input
                  type="text"
                  placeholder="/api/auth/login"
                  value={loginPath}
                  onChange={(e) => setLoginPath(e.target.value)}
                  style={inputStyle}
                  required
                  data-testid="conn-login-path"
                />
              </label>
              <label style={labelStyle}>
                Session cookie name (optional)
                <input
                  type="text"
                  placeholder="session"
                  value={sessionCookieName}
                  onChange={(e) => setSessionCookieName(e.target.value)}
                  style={inputStyle}
                  data-testid="conn-session-cookie"
                />
              </label>
            </>
          )}

          {authType === "oauth_password" && (
            <>
              <p style={{ fontSize: 12, color: "var(--wp-text-dim,#a0a8b4)", marginTop: -4, marginBottom: 12 }}>
                OAuth Resource-Owner-Password grant. Base URL above is the login
                host (<code>https://test.salesforce.com</code> for a sandbox,{" "}
                <code>https://login.salesforce.com</code> for production). We
                exchange the consumer key/secret + user login for a token at the
                token path, stored encrypted at rest.
              </p>
              <label style={labelStyle}>
                Consumer key / client_id
                <input
                  type="text"
                  placeholder="3MVG9..."
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-client-id"
                />
              </label>
              <label style={labelStyle}>
                Consumer secret
                <input
                  type="password"
                  placeholder="••••••••"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-client-secret"
                />
              </label>
              <label style={labelStyle}>
                Username or email
                <input
                  type="text"
                  placeholder="user@example.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-username"
                />
              </label>
              <label style={labelStyle}>
                Password
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={inputStyle}
                  required
                  autoComplete="off"
                  data-testid="conn-password"
                />
              </label>
              <p style={{ fontSize: 12, color: "var(--wp-text-dim,#a0a8b4)", marginTop: -8, marginBottom: 12 }}>
                For Salesforce, append your security token to the password
                (password + security token, no space).
              </p>
              <label style={labelStyle}>
                Token path
                <input
                  type="text"
                  placeholder="/services/oauth2/token"
                  value={loginPath}
                  onChange={(e) => setLoginPath(e.target.value)}
                  style={inputStyle}
                  required
                  data-testid="conn-login-path"
                />
              </label>
            </>
          )}

          <label style={labelStyle}>
            Object map (JSON, optional)
            <textarea
              value={objectMapText}
              onChange={(e) => setObjectMapText(e.target.value)}
              rows={6}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 13 }}
            />
          </label>

          <button
            type="submit"
            data-testid="conn-submit"
            disabled={
              submitting ||
              !baseUrl ||
              (authType === "static_bearer"
                ? !authHeader
                : authType === "oauth_password"
                  ? !clientId || !clientSecret || !username || !password || !loginPath
                  : !username || !password || !loginPath)
            }
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
            {submitting ? "Saving…" : "Save credentials"}
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

const badgeOauthStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  marginLeft: 8,
  background: "rgba(34,197,94,0.15)",
  color: "var(--wp-green,#22c55e)",
  border: "1px solid rgba(34,197,94,0.4)",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
};

const badgeStaticStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  marginLeft: 8,
  background: "rgba(160,168,180,0.15)",
  color: "var(--wp-text-dim,#a0a8b4)",
  border: "1px solid rgba(160,168,180,0.3)",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
};
