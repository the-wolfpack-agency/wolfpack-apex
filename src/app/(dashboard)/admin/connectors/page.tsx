"use client";

/**
 * /admin/connectors — manage per-tenant connector credentials.
 *
 * CTO/CEO only (enforced by /api/admin/connectors). Lists active
 * credentials with masked auth-header hints, lets an admin add /
 * update an entry. Plaintext NEVER appears on screen after save —
 * the form clears the auth-header input and we re-fetch the masked
 * list.
 *
 * Vendor presets (HubSpot / Salesforce / QuickBooks) auto-fill
 * baseUrl + objectMap when picked from the dropdown so the operator
 * only types the auth header.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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

export default function AdminConnectorsPage() {
  const [rows, setRows] = useState<MaskedConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [vendor, setVendor] = useState("rest-default");
  const [baseUrl, setBaseUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [objectMapText, setObjectMapText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [okMessage, setOkMessage] = useState<string | null>(null);

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
      setRows(data.connectors ?? []);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  /* When the operator picks a vendor preset, prefill the URL +
     objectMap fields so they only have to type the auth header. */
  useEffect(() => {
    setBaseUrl(selected.baseUrl);
    setObjectMapText(selected.objectMap);
  }, [selected]);

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

      const res = await fetchWithRefresh("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorName: vendor,
          baseUrl,
          authHeader,
          objectMap,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `HTTP ${res.status}`);
        return;
      }
      setOkMessage(`Saved ${vendor}. Tools using this connector will pick up the new credentials immediately.`);
      setAuthHeader(""); // never keep plaintext in the form
      await loadRows();
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: 24, color: "var(--wp-text,#fff)" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Connectors</h1>
      <p style={{ color: "var(--wp-text-dim,#a0a8b4)", marginBottom: 24 }}>
        External-system credentials used by Assistant tools. Auth headers are
        encrypted at rest (AES-256-GCM) and never re-rendered in plaintext.
      </p>

      <section style={cardStyle}>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Active connectors</h2>
        {loading && <p>Loading…</p>}
        {!loading && rows.length === 0 && <p style={{ color: "var(--wp-text-dim,#a0a8b4)" }}>None configured yet.</p>}
        {rows.map((r) => (
          <div
            key={`${r.workspaceId}:${r.connectorName}`}
            style={{
              padding: 12,
              borderBottom: "1px solid var(--wp-dark-border,#2a2c30)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong>{r.connectorName}</strong>
              <small style={{ color: "var(--wp-text-dim,#a0a8b4)" }}>
                updated {new Date(r.updatedAt).toLocaleString()}
              </small>
            </div>
            <div style={{ fontSize: 13, color: "var(--wp-text-dim,#a0a8b4)", marginTop: 4 }}>
              <div>baseUrl: {r.baseUrl}</div>
              <div>auth: <code>{r.authHeaderHint}</code></div>
              {r.objectMap && (
                <div>objects: {Object.keys(r.objectMap).join(", ")}</div>
              )}
            </div>
          </div>
        ))}
      </section>

      <section style={{ ...cardStyle, marginTop: 24 }}>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Add / update connector</h2>
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
            Base URL
            <input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              style={inputStyle}
              required
            />
          </label>

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
            />
          </label>

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
            disabled={submitting || !baseUrl || !authHeader}
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
          {error && <p style={{ color: "var(--wp-red,#ef4444)", marginTop: 12 }}>{error}</p>}
          {okMessage && <p style={{ color: "var(--wp-green,#22c55e)", marginTop: 12 }}>{okMessage}</p>}
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
