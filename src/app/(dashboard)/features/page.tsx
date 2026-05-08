"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  submitted_by: string;
  status: string;
  priority: string;
  target_product: string | null;
  analysis: Record<string, unknown>;
  votes: number;
  estimated_hours: number | null;
  estimated_cost: number | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  submitted: "var(--wp-info)",
  analyzing: "var(--wp-warning)",
  approved: "var(--wp-success)",
  in_progress: "var(--wp-gold)",
  completed: "var(--wp-success)",
  rejected: "var(--wp-error)",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "var(--wp-text-dim)",
  medium: "var(--wp-info)",
  high: "var(--wp-warning)",
  critical: "var(--wp-error)",
};

export default function FeaturesPage() {
  const [features, setFeatures] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<"feature" | "automation">("feature");
  const [selected, setSelected] = useState<FeatureRequest | null>(null);

  // Edit-in-place state: only one row editable at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<string>("medium");
  const [editTargetProduct, setEditTargetProduct] = useState("");
  const [saving, setSaving] = useState(false);

  // Form fields
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetProduct, setTargetProduct] = useState("");
  const [priority, setPriority] = useState("medium");
  // Automation fields
  const [manualTask, setManualTask] = useState("");
  const [frequency, setFrequency] = useState("");
  const [duration, setDuration] = useState("");
  const [tools, setTools] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState("");

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchFeatures();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "features" } }),
    }).catch(() => {});
     
  }, []);

  async function fetchFeatures() {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/features");
      const data = await res.json();
      setFeatures(data.features || []);
    } catch {
      setFeatures([]);
    }
    setLoading(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMsg("");

    let body: Record<string, unknown>;

    if (formType === "automation") {
      const freqPerWeek = parseFloat(frequency) || 1;
      const durationMin = parseFloat(duration) || 15;
      const timeSavedWeekly = freqPerWeek * durationMin;
      const timeSavedYearly = timeSavedWeekly * 52;
      const hourlyRate = 150;
      const estimatedCost = durationMin * hourlyRate; // rough estimate
      const automationRoi = estimatedCost > 0 ? ((timeSavedYearly / 60) * hourlyRate) / estimatedCost : 0;

      body = {
        title: `[Automation] ${manualTask}`,
        description: `**What I do manually:** ${manualTask}\n**How often:** ${frequency}x/week\n**How long it takes:** ${duration} minutes\n**Tools used:** ${tools}\n\n**Estimated time saved weekly:** ${timeSavedWeekly} minutes\n**Estimated time saved yearly:** ${Math.round(timeSavedYearly / 60)} hours\n**Automation ROI:** ${automationRoi.toFixed(1)}x`,
        target_product: targetProduct || undefined,
        priority,
        category: "automation",
      };
    } else {
      body = {
        title,
        description,
        target_product: targetProduct || undefined,
        priority,
        category: "feature",
      };
    }

    try {
      const res = await fetchWithRefresh("/api/features", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSubmitMsg("Feature request submitted!");
        setTitle("");
        setDescription("");
        setManualTask("");
        setFrequency("");
        setDuration("");
        setTools("");
        setTargetProduct("");
        setPriority("medium");
        setShowForm(false);
        fetchFeatures();
      } else {
        const data = await res.json();
        setSubmitMsg(data.error || "Failed to submit");
      }
    } catch {
      setSubmitMsg("Failed to submit");
    }
    setSubmitting(false);
  }

  function startEdit(f: FeatureRequest) {
    setEditingId(f.id);
    setEditTitle(f.title);
    setEditDescription(f.description);
    setEditPriority(f.priority || "medium");
    setEditTargetProduct(f.target_product || "");
    setSubmitMsg("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle("");
    setEditDescription("");
    setEditPriority("medium");
    setEditTargetProduct("");
  }

  async function handleSaveEdit(e: FormEvent, featureId: string) {
    e.preventDefault();
    setSaving(true);
    setSubmitMsg("");
    try {
      const res = await fetchWithRefresh(`/api/features/${featureId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
          priority: editPriority,
          target_product: editTargetProduct || null,
        }),
      });
      if (res.status === 200) {
        setSubmitMsg("Feature request submitted!"); // reuse positive banner copy
        cancelEdit();
        fetchFeatures();
      } else if (res.status === 403) {
        setSubmitMsg("Only the submitter or an admin can edit this request.");
      } else {
        const data = await res.json().catch(() => ({}));
        setSubmitMsg((data as { error?: string }).error || "Failed to save");
      }
    } catch {
      setSubmitMsg("Failed to save");
    }
    setSaving(false);
  }

  async function handleDelete(featureId: string) {
    if (!window.confirm("Delete this feature request? This cannot be undone.")) {
      return;
    }
    // Optimistic removal so the UI feels instant.
    setFeatures((prev) => prev.filter((f) => f.id !== featureId));
    try {
      const res = await fetchWithRefresh(`/api/features/${featureId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      // Root cause of the "Failed to delete appears even though it worked"
      // false-negative: this branch previously checked `res.status === 200`,
      // which fails the moment the API returns 204 No Content (common for
      // DELETE) or goes through any proxy that rewrites the success code.
      // `res.ok` covers 200..299 uniformly — no body parsing required.
      if (res.ok) {
        setSubmitMsg("Feature request submitted!"); // reuse positive banner copy
      } else if (res.status === 403) {
        setSubmitMsg("Only the submitter or an admin can delete this request.");
        fetchFeatures();
      } else {
        setSubmitMsg("Failed to delete");
        fetchFeatures();
      }
    } catch {
      setSubmitMsg("Failed to delete");
      fetchFeatures();
    }
  }

  async function handleVote(featureId: string) {
    setFeatures((prev) =>
      prev.map((f) => (f.id === featureId ? { ...f, votes: f.votes + 1 } : f))
    );
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        event: "feature.request_submitted",
        metadata: { feature_id: featureId, action: "vote" },
      }),
    }).catch(() => {});
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Feature Requests
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowForm(!showForm); setFormType("feature"); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            Submit Request
          </button>
          <button
            onClick={() => { setShowForm(!showForm); setFormType("automation"); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors border"
            style={{
              background: "transparent",
              borderColor: "var(--wp-gold)",
              color: "var(--wp-gold)",
            }}
          >
            Suggest Automation
          </button>
        </div>
      </div>

      {submitMsg && (
        <div
          className="rounded-lg px-4 py-2.5 text-sm"
          style={{
            background: submitMsg.includes("submitted") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            color: submitMsg.includes("submitted") ? "var(--wp-success)" : "var(--wp-error)",
          }}
        >
          {submitMsg}
        </div>
      )}

      {/* Submit Form */}
      {showForm && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            {formType === "automation" ? "Suggest an Automation" : "Submit Feature Request"}
          </h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            {formType === "feature" ? (
              <>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Feature title"
                  required
                  className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the feature in detail..."
                  required
                  rows={4}
                  className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={manualTask}
                  onChange={(e) => setManualTask(e.target.value)}
                  placeholder="What do you do manually?"
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
                    type="number"
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                    placeholder="How many times per week?"
                    required
                    className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  />
                  <input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    placeholder="Minutes per occurrence"
                    required
                    className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  />
                </div>
                <input
                  type="text"
                  value={tools}
                  onChange={(e) => setTools(e.target.value)}
                  placeholder="What tools do you use? (e.g., Excel, Slack, email)"
                  className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <select
                value={targetProduct}
                onChange={(e) => setTargetProduct(e.target.value)}
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              >
                <option value="">Target Product (optional)</option>
                <option value="apex">Instinct</option>
                <option value="wolfpack-auto">Wolfpack Auto</option>
                <option value="agenticqa">AgenticQA</option>
                <option value="other">Other</option>
              </select>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              >
                <option value="low">Low Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="high">High Priority</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {submitting ? "Submitting..." : "Submit"}
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

      {/* Feature List */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading features...</p>
      ) : features.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p style={{ color: "var(--wp-text-muted)" }}>No feature requests yet. Be the first to submit one!</p>
        </div>
      ) : (
        <div className="space-y-2">
          {features.map((f) => (
            <div
              key={f.id}
              className="rounded-lg border p-4 cursor-pointer wp-hover-lift outline-none"
              style={{
                background: selected?.id === f.id ? "var(--wp-dark-surface2)" : "var(--wp-dark-surface)",
                borderColor: selected?.id === f.id ? "var(--wp-gold)" : "var(--wp-dark-border)",
              }}
              onClick={() => setSelected(selected?.id === f.id ? null : f)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{f.title}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: `${STATUS_COLORS[f.status] || "var(--wp-text-dim)"}20`,
                        color: STATUS_COLORS[f.status] || "var(--wp-text-dim)",
                      }}
                    >
                      {f.status.replace(/_/g, " ")}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: `${PRIORITY_COLORS[f.priority] || "var(--wp-text-dim)"}20`,
                        color: PRIORITY_COLORS[f.priority] || "var(--wp-text-dim)",
                      }}
                    >
                      {f.priority}
                    </span>
                    {f.target_product && (
                      <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        {f.target_product}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleVote(f.id);
                  }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border transition-colors hover:border-[var(--wp-gold)]"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text-dim)",
                  }}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                  </svg>
                  {f.votes}
                </button>
              </div>

              {/* Expanded */}
              {selected?.id === f.id && (
                <div className="mt-4 pt-4 border-t space-y-3" style={{ borderColor: "var(--wp-dark-border)" }}>
                  {editingId === f.id ? (
                    <form
                      data-testid={`feature-edit-form-${f.id}`}
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => handleSaveEdit(e, f.id)}
                      className="space-y-3"
                    >
                      <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        Title
                        <input
                          aria-label="edit title"
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          required
                          className="w-full rounded-lg border px-3 py-2 text-sm outline-none mt-1"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            borderColor: "var(--wp-dark-border)",
                            color: "var(--wp-text)",
                          }}
                        />
                      </label>
                      <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        Description
                        <textarea
                          aria-label="edit description"
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          required
                          rows={4}
                          className="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none mt-1"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            borderColor: "var(--wp-dark-border)",
                            color: "var(--wp-text)",
                          }}
                        />
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
                          Priority
                          <select
                            aria-label="edit priority"
                            value={editPriority}
                            onChange={(e) => setEditPriority(e.target.value)}
                            className="w-full rounded-lg border px-3 py-2 text-sm outline-none mt-1"
                            style={{
                              background: "var(--wp-dark-surface2)",
                              borderColor: "var(--wp-dark-border)",
                              color: "var(--wp-text)",
                            }}
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="critical">Critical</option>
                          </select>
                        </label>
                        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
                          Target product
                          <input
                            aria-label="edit target product"
                            type="text"
                            value={editTargetProduct}
                            onChange={(e) => setEditTargetProduct(e.target.value)}
                            className="w-full rounded-lg border px-3 py-2 text-sm outline-none mt-1"
                            style={{
                              background: "var(--wp-dark-surface2)",
                              borderColor: "var(--wp-dark-border)",
                              color: "var(--wp-text)",
                            }}
                          />
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={saving}
                          className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
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
                          className="px-3 py-1.5 rounded-lg text-sm font-medium"
                          style={{ color: "var(--wp-text-dim)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--wp-text-dim)" }}>
                      {f.description}
                    </p>
                  )}

                  {editingId !== f.id && (
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        data-testid={`feature-edit-btn-${f.id}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          startEdit(f);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:border-[var(--wp-gold)]"
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
                        data-testid={`feature-delete-btn-${f.id}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handleDelete(f.id);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                        style={{
                          background: "transparent",
                          borderColor: "var(--wp-error)",
                          color: "var(--wp-error)",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}

                  {f.estimated_hours != null && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>Estimated Hours</p>
                        <p className="text-sm font-medium" style={{ color: "var(--wp-gold)" }}>
                          {f.estimated_hours}h
                        </p>
                      </div>
                      <div>
                        <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>Estimated Cost</p>
                        <p className="text-sm font-medium" style={{ color: "var(--wp-gold)" }}>
                          ${f.estimated_cost?.toLocaleString()}
                        </p>
                      </div>
                      {f.analysis && "complexity" in f.analysis ? (
                        <div>
                          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>Complexity</p>
                          <p className="text-sm font-medium">{String(f.analysis.complexity)}</p>
                        </div>
                      ) : null}
                      {f.analysis && "risk_factors" in f.analysis ? (
                        <div>
                          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>Risk Factors</p>
                          <p className="text-sm font-medium">
                            {Array.isArray(f.analysis.risk_factors) ? f.analysis.risk_factors.length : 0}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}

                  <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    By {f.submitted_by} on {new Date(f.created_at).toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
