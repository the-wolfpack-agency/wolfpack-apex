"use client";

import { useState, useEffect } from "react";
import { jsonHeaders } from "@/lib/client-auth";

interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  requiredVariables: string[];
  optionalVariables: string[];
}

interface EmailDraft {
  subject: string;
  body: string;
  templateId: string;
  generatedAt: string;
}

const VARIABLE_LABELS: Record<string, string> = {
  clientName: "Client Name",
  productName: "Product Name",
  features: "Features (comma-separated)",
  pricing: "Pricing (optional)",
  meetingDate: "Meeting Date",
  actionItems: "Action Items (comma-separated)",
  projectName: "Project Name",
  completedItems: "Completed Items (comma-separated)",
  upcomingItems: "Upcoming Items (comma-separated)",
  loginUrl: "Login URL",
  adminUrl: "Admin Dashboard URL",
  senderName: "Sender Name (optional)",
};

export default function EmailsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    loadTemplates();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "emails" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplates() {
    setLoading(true);
    try {
      const res = await fetch("/api/emails", { headers: authHeaders() });
      if (!res.ok) {
        setError("Failed to load templates");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch {
      setError("Failed to connect to email API");
    }
    setLoading(false);
  }

  function selectTemplate(template: EmailTemplate) {
    setSelectedTemplate(template);
    setDraft(null);
    setCopied(false);
    setError(null);
    // Initialize form values
    const values: Record<string, string> = {};
    for (const v of [...template.requiredVariables, ...template.optionalVariables]) {
      values[v] = "";
    }
    setFormValues(values);
  }

  async function handleGenerate() {
    if (!selectedTemplate) return;
    setGenerating(true);
    setError(null);
    setCopied(false);

    try {
      // Build the body based on template type
      const body: Record<string, unknown> = { templateId: selectedTemplate.id };

      for (const [key, value] of Object.entries(formValues)) {
        if (!value.trim()) continue;
        // Convert comma-separated fields to arrays for the API
        if (
          ["features", "actionItems", "completedItems", "upcomingItems"].includes(key) &&
          value.includes(",")
        ) {
          body[key] = value.split(",").map((s) => s.trim());
        } else if (["features", "actionItems", "completedItems", "upcomingItems"].includes(key)) {
          body[key] = [value.trim()];
        } else {
          body[key] = value.trim();
        }
      }

      const res = await fetch("/api/emails", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to generate email");
        setGenerating(false);
        return;
      }

      setDraft(data.draft);
    } catch {
      setError("Failed to generate email");
    }
    setGenerating(false);
  }

  async function handleCopy() {
    if (!draft) return;
    const text = `Subject: ${draft.subject}\n\n${draft.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Email Templates
      </h1>
      <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
        Generate professional client emails instantly — zero tokens, pure templates.
      </p>

      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading templates...</p>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Template Picker (Left) */}
          <div className="lg:w-72 shrink-0 space-y-2">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTemplate(t)}
                className="w-full text-left rounded-lg border p-4 transition-colors"
                style={{
                  background:
                    selectedTemplate?.id === t.id ? "var(--wp-dark-surface2)" : "var(--wp-dark-surface)",
                  borderColor:
                    selectedTemplate?.id === t.id ? "var(--wp-gold)" : "var(--wp-dark-border)",
                }}
              >
                <p className="text-sm font-semibold" style={{ color: "var(--wp-text)" }}>
                  {t.name}
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>
                  {t.description}
                </p>
              </button>
            ))}
          </div>

          {/* Form + Preview (Right) */}
          <div className="flex-1 space-y-4">
            {selectedTemplate ? (
              <>
                {/* Form */}
                <div
                  className="rounded-lg border p-5"
                  style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
                >
                  <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
                    {selectedTemplate.name}
                  </h3>
                  <div className="space-y-3">
                    {[...selectedTemplate.requiredVariables, ...selectedTemplate.optionalVariables].map(
                      (varName) => (
                        <div key={varName}>
                          <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text)" }}>
                            {VARIABLE_LABELS[varName] || varName}
                            {selectedTemplate.requiredVariables.includes(varName) && (
                              <span style={{ color: "var(--wp-error)" }}> *</span>
                            )}
                          </label>
                          {varName.includes("Items") || varName === "features" ? (
                            <textarea
                              value={formValues[varName] || ""}
                              onChange={(e) =>
                                setFormValues((prev) => ({ ...prev, [varName]: e.target.value }))
                              }
                              rows={2}
                              placeholder={VARIABLE_LABELS[varName] || varName}
                              className="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                              style={{
                                background: "var(--wp-dark-surface2)",
                                borderColor: "var(--wp-dark-border)",
                                color: "var(--wp-text)",
                              }}
                            />
                          ) : (
                            <input
                              type="text"
                              value={formValues[varName] || ""}
                              onChange={(e) =>
                                setFormValues((prev) => ({ ...prev, [varName]: e.target.value }))
                              }
                              placeholder={VARIABLE_LABELS[varName] || varName}
                              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                              style={{
                                background: "var(--wp-dark-surface2)",
                                borderColor: "var(--wp-dark-border)",
                                color: "var(--wp-text)",
                              }}
                            />
                          )}
                        </div>
                      ),
                    )}
                  </div>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="mt-4 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                    style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                  >
                    {generating ? "Generating..." : "Generate Email"}
                  </button>
                </div>

                {/* Error */}
                {error && (
                  <div
                    className="rounded-lg border p-3"
                    style={{ borderColor: "var(--wp-error)" }}
                  >
                    <p className="text-sm" style={{ color: "var(--wp-error)" }}>
                      {error}
                    </p>
                  </div>
                )}

                {/* Preview */}
                {draft && (
                  <div
                    className="rounded-lg border p-5"
                    style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
                  >
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                      <h3 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
                        Email Preview
                      </h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                          0 tokens used
                        </span>
                        <button
                          onClick={handleCopy}
                          className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                          style={{
                            background: copied ? "var(--wp-success)" : "var(--wp-dark-surface2)",
                            color: copied ? "var(--wp-dark)" : "var(--wp-text)",
                          }}
                        >
                          {copied ? "Copied!" : "Copy to Clipboard"}
                        </button>
                      </div>
                    </div>

                    <div
                      className="rounded-lg border p-4"
                      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                    >
                      <p className="text-xs font-medium mb-1" style={{ color: "var(--wp-text-muted)" }}>
                        Subject:
                      </p>
                      <p className="text-sm font-semibold mb-4" style={{ color: "var(--wp-text)" }}>
                        {draft.subject}
                      </p>
                      <div
                        className="border-t pt-3"
                        style={{ borderColor: "var(--wp-dark-border)" }}
                      >
                        <pre
                          className="text-sm whitespace-pre-wrap font-sans"
                          style={{ color: "var(--wp-text-dim)" }}
                        >
                          {draft.body}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                className="rounded-lg border p-8 text-center"
                style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
              >
                <p style={{ color: "var(--wp-text-muted)" }}>
                  Select a template to get started
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
