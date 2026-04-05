"use client";

import { useState, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SectionInfo {
  id: string;
  title: string;
  description: string;
  dataSource: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: "client" | "internal" | "technical";
  sections: SectionInfo[];
  defaultIncluded: string[];
}

interface ReportHistoryItem {
  id: string;
  title: string;
  created_at: string;
  generated_from: string | null;
}

interface GeneratedReportResult {
  reportId: string;
  markdown: string;
  html: string;
  generatedAt: string;
  sectionsIncluded: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  client: "var(--wp-gold)",
  internal: "var(--wp-info)",
  technical: "var(--wp-success)",
};

const CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  internal: "Internal",
  technical: "Technical",
};

const CATEGORY_ICONS: Record<string, string> = {
  client: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4",
  internal: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  technical: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReportsPage() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [history, setHistory] = useState<ReportHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Selected template
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateInfo | null>(null);

  // Section selection
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set());

  // Context form
  const [clientName, setClientName] = useState("");
  const [dealerName, setDealerName] = useState("");
  const [productName, setProductName] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [customNotes, setCustomNotes] = useState("");

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<GeneratedReportResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const previewRef = useRef<HTMLIFrameElement>(null);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  // Load templates and history
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/reports", { headers: authHeaders() });
        const data = await res.json();
        setTemplates(data.templates || []);
        setHistory(data.history || []);
      } catch {
        setTemplates([]);
        setHistory([]);
      }
      setLoading(false);
    }
    load();

    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "reports" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTemplate(t: TemplateInfo) {
    setSelectedTemplate(t);
    setSelectedSections(new Set(t.defaultIncluded));
    setGeneratedReport(null);
    setError("");
  }

  function toggleSection(sectionId: string) {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  async function handleGenerate() {
    if (!selectedTemplate) return;
    setGenerating(true);
    setError("");
    setGeneratedReport(null);

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          templateId: selectedTemplate.id,
          sections: Array.from(selectedSections),
          context: {
            clientName,
            dealerName: dealerName || undefined,
            productName: productName || undefined,
            dateRange: dateStart && dateEnd ? { start: dateStart, end: dateEnd } : undefined,
            customNotes: customNotes || undefined,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to generate report");
        return;
      }

      const data = await res.json();
      setGeneratedReport(data);

      // Refresh history
      const histRes = await fetch("/api/reports", { headers: authHeaders() });
      const histData = await histRes.json();
      setHistory(histData.history || []);
    } catch (err) {
      setError((err as Error).message || "Failed to generate report");
    } finally {
      setGenerating(false);
    }
  }

  function handlePrint() {
    if (!previewRef.current?.contentWindow) return;
    previewRef.current.contentWindow.print();
  }

  async function handleCopyMarkdown() {
    if (!generatedReport) return;
    try {
      await navigator.clipboard.writeText(generatedReport.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = generatedReport.markdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleBack() {
    setSelectedTemplate(null);
    setGeneratedReport(null);
    setError("");
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading reports...</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Reports
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            Generate branded reports for clients, stakeholders, and internal audits.
          </p>
        </div>
        {selectedTemplate && (
          <button
            onClick={handleBack}
            className="text-sm px-3 py-1.5 rounded-lg transition-colors"
            style={{
              border: "1px solid var(--wp-dark-border)",
              color: "var(--wp-text-dim)",
            }}
          >
            Back to Templates
          </button>
        )}
      </div>

      {/* Template Picker */}
      {!selectedTemplate && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTemplate(t)}
                className="text-left p-5 rounded-xl border transition-all hover:scale-[1.02]"
                style={{
                  background: "var(--wp-dark-surface)",
                  borderColor: "var(--wp-dark-border)",
                }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ background: `${CATEGORY_COLORS[t.category]}15` }}
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke={CATEGORY_COLORS[t.category]}
                      strokeWidth={1.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d={CATEGORY_ICONS[t.category]} />
                    </svg>
                  </div>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded"
                    style={{
                      background: `${CATEGORY_COLORS[t.category]}20`,
                      color: CATEGORY_COLORS[t.category],
                    }}
                  >
                    {CATEGORY_LABELS[t.category]}
                  </span>
                </div>
                <h3 className="font-semibold text-sm mb-1">{t.name}</h3>
                <p className="text-xs leading-relaxed" style={{ color: "var(--wp-text-dim)" }}>
                  {t.description}
                </p>
                <p className="text-xs mt-2" style={{ color: "var(--wp-text-muted)" }}>
                  {t.sections.length} sections
                </p>
              </button>
            ))}
          </div>

          {/* Report History */}
          {history.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
                Report History
              </h2>
              <div
                className="rounded-xl border overflow-hidden"
                style={{
                  background: "var(--wp-dark-surface)",
                  borderColor: "var(--wp-dark-border)",
                }}
              >
                {history.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between px-4 py-3 border-b last:border-b-0"
                    style={{ borderColor: "var(--wp-dark-border)" }}
                  >
                    <div>
                      <p className="text-sm font-medium">{h.title}</p>
                      <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        {h.generated_from || "report"} | {new Date(h.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Template Configuration */}
      {selectedTemplate && !generatedReport && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Sections */}
          <div
            className="p-5 rounded-xl border"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <h2 className="font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
              Sections — {selectedTemplate.name}
            </h2>
            <div className="space-y-2">
              {selectedTemplate.sections.map((s) => (
                <label
                  key={s.id}
                  className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
                  style={{
                    background: selectedSections.has(s.id)
                      ? "var(--wp-dark-surface2)"
                      : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedSections.has(s.id)}
                    onChange={() => toggleSection(s.id)}
                    className="mt-0.5"
                    style={{ accentColor: "var(--wp-gold)" }}
                  />
                  <div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      {s.description}
                    </p>
                    <span
                      className="inline-block text-xs mt-1 px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--wp-dark-surface)",
                        color: "var(--wp-text-muted)",
                      }}
                    >
                      {s.dataSource}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Context Form */}
          <div
            className="p-5 rounded-xl border"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <h2 className="font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
              Report Details
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                  Client Name *
                </label>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="e.g. Hoxsie Auto Group"
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    border: "1px solid var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                  Dealer Name
                </label>
                <input
                  type="text"
                  value={dealerName}
                  onChange={(e) => setDealerName(e.target.value)}
                  placeholder="e.g. Hoxsie Ford"
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    border: "1px solid var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                  Product Name
                </label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="e.g. Wolfpack Auto"
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    border: "1px solid var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      border: "1px solid var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                    End Date
                  </label>
                  <input
                    type="date"
                    value={dateEnd}
                    onChange={(e) => setDateEnd(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      border: "1px solid var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
                  Custom Notes
                </label>
                <textarea
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  rows={3}
                  placeholder="Additional context for the report..."
                  className="w-full px-3 py-2 rounded-lg text-sm resize-none"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    border: "1px solid var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
              </div>

              {error && (
                <p className="text-sm" style={{ color: "var(--wp-error)" }}>
                  {error}
                </p>
              )}

              <button
                onClick={handleGenerate}
                disabled={generating || selectedSections.size === 0 || !clientName.trim()}
                className="w-full py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
                style={{
                  background: "var(--wp-gold)",
                  color: "var(--wp-dark)",
                }}
              >
                {generating ? "Generating..." : "Generate Report"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report Preview */}
      {generatedReport && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={handlePrint}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              Download PDF
            </button>
            <button
              onClick={handleCopyMarkdown}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                border: "1px solid var(--wp-dark-border)",
                color: copied ? "var(--wp-success)" : "var(--wp-text-dim)",
              }}
            >
              {copied ? "Copied!" : "Copy Markdown"}
            </button>
            <button
              onClick={handleBack}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                border: "1px solid var(--wp-dark-border)",
                color: "var(--wp-text-dim)",
              }}
            >
              New Report
            </button>
          </div>

          <div
            className="rounded-xl border overflow-hidden"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <iframe
              ref={previewRef}
              srcDoc={generatedReport.html}
              className="w-full border-0"
              style={{ minHeight: "80vh" }}
              title="Report Preview"
            />
          </div>
        </div>
      )}
    </div>
  );
}
