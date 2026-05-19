"use client";

/**
 * /portal/salesforce/[type]/[id] — drill-in for one record.
 *
 *   - Renders all non-empty fields the connector returned.
 *   - Each editable field has an inline "Edit" + save button that
 *     PATCHes a single field at a time (mirrors update_external_record
 *     tool's safety contract — never multi-field).
 *   - "Open in Salesforce" external link uses the saved instanceUrl.
 *   - Validates `type` ∈ {contacts, opportunities, accounts}; anything
 *     else renders a 404-ish "unknown record type" panel.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

const PORTAL_TYPES = ["contacts", "opportunities", "accounts"] as const;
type PortalType = (typeof PORTAL_TYPES)[number];

interface RecordResponse {
  notConfigured: boolean;
  record: Record<string, unknown>;
  instanceUrl: string | null;
  connector: string;
}

/* Fields the API allows PATCHing. Keep aligned with
   ALLOWED_PATCH_FIELDS in /api/portal/salesforce/record/route.ts. */
const EDITABLE_FIELDS = new Set([
  "Name",
  "FirstName",
  "LastName",
  "Email",
  "Phone",
  "Title",
  "Description",
  "Amount",
  "StageName",
  "CloseDate",
  "Industry",
  "Website",
  "Status",
]);

function isPortalType(value: string): value is PortalType {
  return (PORTAL_TYPES as readonly string[]).includes(value);
}

function labelFor(type: PortalType): string {
  return type === "contacts" ? "Contact" : type === "opportunities" ? "Opportunity" : "Account";
}

/** Pretty-print a Salesforce field value. Returns null when the field
 *  is empty / nullish — caller hides those rows. */
function renderValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  /* Nested objects (Account, Owner) — show .Name when present, else
     skip. SF returns these as { attributes:{type:"Account",url:"…"},
     Id, Name }. */
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.Name === "string") return obj.Name;
    return null;
  }
  return null;
}

interface PageProps {
  params: Promise<{ type: string; id: string }>;
}

export default function PortalRecordPage({ params }: PageProps) {
  const resolved = use(params);
  const router = useRouter();
  const { type: typeRaw, id: idRaw } = resolved;
  const id = decodeURIComponent(idRaw);

  const [data, setData] = useState<RecordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const validType = isPortalType(typeRaw);

  const load = useCallback(async () => {
    if (!validType) return;
    setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams({ type: typeRaw, id });
      const res = await fetchWithRefresh(`/api/portal/salesforce/record?${search.toString()}`);
      if (!res.ok) {
        setError(`Could not load record (HTTP ${res.status}).`);
        setData(null);
        return;
      }
      const body = (await res.json()) as RecordResponse;
      setData(body);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [validType, typeRaw, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!validType) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, color: "var(--wp-text, #fff)" }}>
        <h1 style={{ fontSize: 22 }}>Unknown record type</h1>
        <p style={{ color: "var(--wp-text-dim, #a0a8b4)" }}>
          Type must be one of: {PORTAL_TYPES.join(", ")}.
        </p>
        <Link href="/portal/salesforce" style={{ color: "var(--wp-gold, #eab308)" }}>
          ← Back to portal
        </Link>
      </div>
    );
  }

  async function handleSave(field: string) {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      /* Coerce numeric fields client-side so the API doesn't 400. */
      let value: string | number = editValue;
      if (field === "Amount") {
        const n = Number(editValue);
        if (Number.isNaN(n)) {
          setSaveError("Amount must be a number");
          setSaving(false);
          return;
        }
        value = n;
      }
      const res = await fetchWithRefresh("/api/portal/salesforce/record", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: typeRaw, id, field, value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body?.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setEditingField(null);
      setEditValue("");
      await load(); // refetch so the displayed value is the canonical SF value
    } catch (e) {
      setSaveError((e as Error).message || "Network error");
    } finally {
      setSaving(false);
    }
  }

  const titleValue = data?.record
    ? (renderValue(data.record.Name) ?? renderValue(data.record.FirstName) ?? `${labelFor(typeRaw as PortalType)} ${id}`)
    : `${labelFor(typeRaw as PortalType)} ${id}`;

  const externalUrl = data?.instanceUrl
    ? `${data.instanceUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`
    : null;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, color: "var(--wp-text, #fff)" }}>
      <div style={{ marginBottom: 8 }}>
        <Link href={`/portal/salesforce/${typeRaw}`} style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>
          ← All {typeRaw}
        </Link>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, margin: 0 }} data-testid="sf-record-title">
          {titleValue}
        </h1>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              background: "var(--wp-dark-surface2, #16181c)",
              color: "var(--wp-text, #fff)",
              border: "1px solid var(--wp-dark-border, #2a2c30)",
              borderRadius: 6,
              textDecoration: "none",
              fontSize: 12,
            }}
            data-testid="sf-record-external-link"
          >
            Open in Salesforce ↗
          </a>
        )}
      </div>
      <p style={{ color: "var(--wp-text-dim, #a0a8b4)", marginTop: 4, fontSize: 12 }}>
        {labelFor(typeRaw as PortalType)} · id <code>{id}</code>
      </p>

      {loading && <p>Loading…</p>}
      {error && (
        <div role="alert" style={{ ...cardStyle, marginBottom: 16, borderColor: "var(--wp-red, #ef4444)" }}>
          <p style={{ color: "var(--wp-red, #ef4444)", margin: 0 }}>{error}</p>
          <button
            type="button"
            onClick={() => router.back()}
            style={{ marginTop: 8, ...linkBtnStyle }}
          >
            Go back
          </button>
        </div>
      )}

      {data?.notConfigured && (
        <div style={cardStyle}>
          <p>Salesforce isn&apos;t connected.</p>
          <Link href="/admin/connectors" style={{ color: "var(--wp-gold, #eab308)" }}>
            Configure /admin/connectors →
          </Link>
        </div>
      )}

      {data && !data.notConfigured && (
        <div style={{ ...cardStyle, padding: 0 }} data-testid="sf-record-fields">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {Object.keys(data.record)
                .filter((k) => k !== "attributes")
                .map((k) => {
                  const val = renderValue(data.record[k]);
                  if (val === null) return null;
                  const editable = EDITABLE_FIELDS.has(k);
                  const isEditing = editingField === k;
                  return (
                    <tr key={k} style={{ borderBottom: "1px solid var(--wp-dark-border, #2a2c30)" }}>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          fontSize: 12,
                          color: "var(--wp-text-dim, #a0a8b4)",
                          width: 180,
                          fontWeight: 500,
                          verticalAlign: "top",
                        }}
                      >
                        {k}
                      </th>
                      <td style={{ padding: "10px 12px", fontSize: 13 }}>
                        {isEditing ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                            <input
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              data-testid={`sf-record-edit-input-${k}`}
                              style={{
                                flex: "1 1 200px",
                                background: "var(--wp-dark-surface2, #16181c)",
                                color: "var(--wp-text, #fff)",
                                border: "1px solid var(--wp-dark-border, #2a2c30)",
                                borderRadius: 6,
                                padding: "6px 10px",
                                fontSize: 13,
                              }}
                            />
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => handleSave(k)}
                              data-testid={`sf-record-save-${k}`}
                              style={primaryBtnStyle}
                            >
                              {saving ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => {
                                setEditingField(null);
                                setEditValue("");
                                setSaveError(null);
                              }}
                              style={linkBtnStyle}
                            >
                              Cancel
                            </button>
                            {saveError && (
                              <span style={{ color: "var(--wp-red, #ef4444)", fontSize: 12 }}>
                                {saveError}
                              </span>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span>{val}</span>
                            {editable && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingField(k);
                                  setEditValue(val);
                                  setSaveError(null);
                                }}
                                data-testid={`sf-record-edit-${k}`}
                                style={{
                                  background: "transparent",
                                  color: "var(--wp-gold, #eab308)",
                                  border: "none",
                                  fontSize: 12,
                                  cursor: "pointer",
                                }}
                              >
                                Edit
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
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
  padding: "6px 12px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark, #111)",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 12,
};

const linkBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "var(--wp-dark-surface2, #16181c)",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-dark-border, #2a2c30)",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
};
