"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders } from "@/lib/client-auth";

interface Client {
  id: string;
  name: string;
  industry: string | null;
  contact_email: string | null;
  contact_name: string | null;
  notes: string | null;
  docs: unknown[];
  created_at: string;
}

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<Client | null>(null);

  // Form
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState("");

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchClients();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "clients" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchClients() {
    setLoading(true);
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      setClients(data.clients || []);
    } catch {
      setClients([]);
    }
    setLoading(false);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMsg("");
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          name,
          industry: industry || undefined,
          contact_email: contactEmail || undefined,
          contact_name: contactName || undefined,
          notes: notes || undefined,
        }),
      });
      if (res.ok) {
        setSubmitMsg("Client created!");
        setName("");
        setIndustry("");
        setContactEmail("");
        setContactName("");
        setNotes("");
        setShowForm(false);
        fetchClients();
      } else {
        const data = await res.json();
        setSubmitMsg(data.error || "Failed to create client");
      }
    } catch {
      setSubmitMsg("Failed to create client");
    }
    setSubmitting(false);
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Clients
        </h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          Add Client
        </button>
      </div>

      {submitMsg && (
        <div
          className="rounded-lg px-4 py-2.5 text-sm"
          style={{
            background: submitMsg.includes("created") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            color: submitMsg.includes("created") ? "var(--wp-success)" : "var(--wp-error)",
          }}
        >
          {submitMsg}
        </div>
      )}

      {/* Create Form */}
      {showForm && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Add New Client
          </h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client name"
              required
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Industry"
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Contact name"
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
            </div>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Contact email"
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes..."
              rows={3}
              className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {submitting ? "Creating..." : "Create Client"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Client List */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading clients...</p>
      ) : clients.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p style={{ color: "var(--wp-text-muted)" }}>No clients yet. Add your first one!</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {clients.map((client) => (
            <div
              key={client.id}
              onClick={() => setSelected(selected?.id === client.id ? null : client)}
              className="rounded-lg border p-4 cursor-pointer transition-colors hover:border-[var(--wp-gold)]"
              style={{
                background: selected?.id === client.id ? "var(--wp-dark-surface2)" : "var(--wp-dark-surface)",
                borderColor: selected?.id === client.id ? "var(--wp-gold)" : "var(--wp-dark-border)",
              }}
            >
              <h3 className="text-sm font-medium">{client.name}</h3>
              <div className="flex items-center gap-2 mt-1.5">
                {client.industry && (
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
                  >
                    {client.industry}
                  </span>
                )}
                {client.docs && (
                  <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    {Array.isArray(client.docs) ? client.docs.length : 0} docs
                  </span>
                )}
              </div>

              {selected?.id === client.id && (
                <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: "var(--wp-dark-border)" }}>
                  {client.contact_name && (
                    <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      Contact: {client.contact_name}
                    </p>
                  )}
                  {client.contact_email && (
                    <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      Email: {client.contact_email}
                    </p>
                  )}
                  {client.notes && (
                    <p className="text-xs mt-2" style={{ color: "var(--wp-text-muted)" }}>
                      {client.notes}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
