"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

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

  // Inline edit state (one row at a time, mirrors /knowledge pattern).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIndustry, setEditIndustry] = useState("");
  const [editContactEmail, setEditContactEmail] = useState("");
  const [editContactName, setEditContactName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchClients();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "clients" } }),
    }).catch(() => {});
     
  }, []);

  async function fetchClients() {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/clients");
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
      const res = await fetchWithRefresh("/api/clients", {
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

  function startEdit(c: Client) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditIndustry(c.industry || "");
    setEditContactEmail(c.contact_email || "");
    setEditContactName(c.contact_name || "");
    setEditNotes(c.notes || "");
    setSubmitMsg("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditIndustry("");
    setEditContactEmail("");
    setEditContactName("");
    setEditNotes("");
  }

  async function handleSaveEdit(e: FormEvent, clientId: string) {
    e.preventDefault();
    setSaving(true);
    setSubmitMsg("");
    try {
      const res = await fetchWithRefresh(`/api/clients/${clientId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          name: editName,
          industry: editIndustry,
          contact_email: editContactEmail,
          contact_name: editContactName,
          notes: editNotes,
        }),
      });
      if (res.status === 200) {
        setSubmitMsg("Client updated.");
        cancelEdit();
        fetchClients();
      } else if (res.status === 403) {
        setSubmitMsg("You don't have permission to edit this client.");
      } else {
        const data = await res.json().catch(() => ({}));
        setSubmitMsg((data as { error?: string }).error || "Failed to save");
      }
    } catch {
      setSubmitMsg("Failed to save");
    }
    setSaving(false);
  }

  async function handleDelete(clientId: string) {
    if (!window.confirm("Delete this client? This cannot be undone.")) {
      return;
    }
    setClients((prev) => prev.filter((c) => c.id !== clientId));
    if (selected?.id === clientId) setSelected(null);
    try {
      const res = await fetchWithRefresh(`/api/clients/${clientId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.status === 200) {
        setSubmitMsg("Client deleted.");
      } else if (res.status === 403) {
        setSubmitMsg("You don't have permission to delete this client.");
        fetchClients();
      } else {
        setSubmitMsg("Failed to delete");
        fetchClients();
      }
    } catch {
      setSubmitMsg("Failed to delete");
      fetchClients();
    }
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
                <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: "var(--wp-dark-border)" }}>
                  {editingId === client.id ? (
                    <form
                      data-testid={`client-edit-form-${client.id}`}
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => handleSaveEdit(e, client.id)}
                      className="space-y-2"
                    >
                      <input
                        aria-label="edit name"
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Name"
                        required
                        className="w-full rounded border px-2 py-1.5 text-xs outline-none"
                        style={{
                          background: "var(--wp-dark-surface2)",
                          borderColor: "var(--wp-dark-border)",
                          color: "var(--wp-text)",
                        }}
                      />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          aria-label="edit industry"
                          type="text"
                          value={editIndustry}
                          onChange={(e) => setEditIndustry(e.target.value)}
                          placeholder="Industry"
                          className="w-full rounded border px-2 py-1.5 text-xs outline-none"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            borderColor: "var(--wp-dark-border)",
                            color: "var(--wp-text)",
                          }}
                        />
                        <input
                          aria-label="edit contact name"
                          type="text"
                          value={editContactName}
                          onChange={(e) => setEditContactName(e.target.value)}
                          placeholder="Contact name"
                          className="w-full rounded border px-2 py-1.5 text-xs outline-none"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            borderColor: "var(--wp-dark-border)",
                            color: "var(--wp-text)",
                          }}
                        />
                      </div>
                      <input
                        aria-label="edit contact email"
                        type="email"
                        value={editContactEmail}
                        onChange={(e) => setEditContactEmail(e.target.value)}
                        placeholder="Contact email"
                        className="w-full rounded border px-2 py-1.5 text-xs outline-none"
                        style={{
                          background: "var(--wp-dark-surface2)",
                          borderColor: "var(--wp-dark-border)",
                          color: "var(--wp-text)",
                        }}
                      />
                      <textarea
                        aria-label="edit notes"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        rows={2}
                        placeholder="Notes"
                        className="w-full rounded border px-2 py-1.5 text-xs outline-none resize-none"
                        style={{
                          background: "var(--wp-dark-surface2)",
                          borderColor: "var(--wp-dark-border)",
                          color: "var(--wp-text)",
                        }}
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={saving}
                          className="px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50"
                          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                        >
                          {saving ? "Saving..." : "Save changes"}
                        </button>
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            cancelEdit();
                          }}
                          className="px-3 py-1.5 rounded text-xs font-medium"
                          style={{ color: "var(--wp-text-dim)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
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
                      <div className="flex gap-2 flex-wrap pt-2">
                        <button
                          type="button"
                          data-testid={`client-edit-btn-${client.id}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            startEdit(client);
                          }}
                          className="px-2.5 py-1 rounded text-xs font-medium border hover:border-[var(--wp-gold)]"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            borderColor: "var(--wp-dark-border)",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid={`client-delete-btn-${client.id}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleDelete(client.id);
                          }}
                          className="px-2.5 py-1 rounded text-xs font-medium border"
                          style={{
                            background: "transparent",
                            borderColor: "var(--wp-error)",
                            color: "var(--wp-error)",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
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
