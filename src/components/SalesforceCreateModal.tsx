"use client";

/**
 * SalesforceCreateModal — single create form for the portal.
 *
 * One component handles all three types (contacts / opportunities /
 * accounts) — the field set switches on `type`. Submits to
 * POST /api/portal/salesforce/record which validates the field
 * allow-list server-side, so anything we render here that isn't on
 * the allow-list returns 400.
 *
 * On success, the modal closes + onCreated fires with the new id so
 * the parent page can route to the new drill-in.
 */

import { useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface SalesforceCreateModalProps {
  open: boolean;
  type: "contacts" | "opportunities" | "accounts";
  onClose: () => void;
  onCreated: (id: string) => void;
}

interface FieldDef {
  name: string;
  label: string;
  type: "text" | "email" | "tel" | "number" | "date" | "url";
  required?: boolean;
  placeholder?: string;
}

/* Field sets per type. Stays in lockstep with the API route's
   ALLOWED_PATCH_FIELDS — pruning a field here without pruning there
   leaves a 400-on-submit landmine. */
const FIELDS_BY_TYPE: Record<SalesforceCreateModalProps["type"], FieldDef[]> = {
  contacts: [
    { name: "FirstName", label: "First name", type: "text", placeholder: "Jane" },
    { name: "LastName", label: "Last name", type: "text", required: true, placeholder: "Doe" },
    { name: "Email", label: "Email", type: "email", placeholder: "jane@example.com" },
    { name: "Phone", label: "Phone", type: "tel", placeholder: "555-0101" },
    { name: "Title", label: "Title", type: "text", placeholder: "VP Operations" },
  ],
  opportunities: [
    { name: "Name", label: "Opportunity name", type: "text", required: true, placeholder: "Acme Q3 Renewal" },
    { name: "Amount", label: "Amount ($)", type: "number", placeholder: "50000" },
    { name: "StageName", label: "Stage", type: "text", placeholder: "Prospecting" },
    { name: "CloseDate", label: "Close date", type: "date" },
  ],
  accounts: [
    { name: "Name", label: "Account name", type: "text", required: true, placeholder: "Acme Industries" },
    { name: "Industry", label: "Industry", type: "text", placeholder: "Manufacturing" },
    { name: "Phone", label: "Phone", type: "tel" },
    { name: "Website", label: "Website", type: "url", placeholder: "https://acme.com" },
  ],
};

export default function SalesforceCreateModal({
  open,
  type,
  onClose,
  onCreated,
}: SalesforceCreateModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const fields = FIELDS_BY_TYPE[type];

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      /* Coerce number fields before send; the API validates that
         numeric Salesforce fields (Amount) arrive as numbers. */
      const payload: Record<string, string | number> = {};
      for (const f of fields) {
        const raw = values[f.name];
        if (raw === undefined || raw === "") continue;
        if (f.type === "number") {
          const n = Number(raw);
          if (Number.isNaN(n)) {
            setError(`${f.label} must be a number`);
            setSubmitting(false);
            return;
          }
          payload[f.name] = n;
        } else {
          payload[f.name] = raw;
        }
      }
      const required = fields.find((f) => f.required && !payload[f.name]);
      if (required) {
        setError(`${required.label} is required`);
        setSubmitting(false);
        return;
      }
      const res = await fetchWithRefresh("/api/portal/salesforce/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, fields: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body?.error ?? `Create failed (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as { id: string };
      onCreated(data.id);
      setValues({});
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const labelByType: Record<SalesforceCreateModalProps["type"], string> = {
    contacts: "Contact",
    opportunities: "Opportunity",
    accounts: "Account",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
      data-testid="sf-create-overlay"
    >
      <div
        className="w-full max-w-md rounded-lg border flex flex-col max-h-[85vh]"
        style={{
          background: "var(--wp-dark-surface, #1c1e22)",
          borderColor: "var(--wp-dark-border, #2a2c30)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Create ${labelByType[type]}`}
        data-testid="sf-create-modal"
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--wp-dark-border, #2a2c30)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--wp-gold, #eab308)" }}>
            New {labelByType[type]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs"
            style={{ color: "var(--wp-text-muted, #a0a8b4)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
          data-testid="sf-create-form"
        >
          {fields.map((f) => (
            <label key={f.name} className="block text-xs" style={{ color: "var(--wp-text-dim, #a0a8b4)" }}>
              {f.label}
              {f.required ? " *" : ""}
              <input
                type={f.type}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.placeholder}
                required={f.required}
                data-testid={`sf-create-field-${f.name}`}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                style={{
                  background: "var(--wp-dark-surface2, #16181c)",
                  color: "var(--wp-text, #fff)",
                  borderColor: "var(--wp-dark-border, #2a2c30)",
                }}
              />
            </label>
          ))}
          {error && (
            <p role="alert" className="text-xs" style={{ color: "var(--wp-red, #ef4444)" }}>
              {error}
            </p>
          )}
        </form>

        <div
          className="px-5 py-3 border-t flex justify-end gap-2"
          style={{ borderColor: "var(--wp-dark-border, #2a2c30)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded text-xs"
            style={{
              background: "var(--wp-dark-surface2, #16181c)",
              color: "var(--wp-text, #fff)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="sf-create-submit"
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold, #eab308)",
              color: "var(--wp-dark, #111)",
            }}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
