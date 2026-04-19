"use client";

/**
 * FigmaImporter — "seed a site from a Figma file" panel.
 *
 * Designer pastes a Figma URL (file or design); we POST it to
 * /api/figma/import; the response contains a structured
 * `briefSuggestion` (theme + pages). The preview card shows the scraped
 * file metadata, the color palette ranked by frequency, the font list,
 * and the frame list with "this looks like a <hero|cards|…> section"
 * hints so the designer can audit before applying.
 *
 * Apply:
 *   - Parent owns the merge — we hand back the structured suggestion
 *     via `onApply(briefSuggestion)`. The parent decides whether to
 *     merge into the current brief, seed a new one, etc.
 *   - Fires `figma_import_applied` analytics with a count of applied
 *     pages + theme fields; that's the KPI for the importer.
 *
 * Auth: fetchWithRefresh, never raw fetch.
 *
 * Security:
 *   - The access token lives server-side only. This component never
 *     sees or touches it. Rendering never includes the token in any
 *     DOM attribute.
 */

import { useCallback, useMemo, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type {
  FigmaImportResult,
  FigmaBriefSuggestion,
} from "@/lib/figma-import";

export interface FigmaImporterProps {
  /**
   * Called when the designer clicks "Apply to this site". Parent owns
   * the state shape; we just hand back the structured suggestion.
   */
  onApply: (suggestion: FigmaBriefSuggestion) => void;
  /** Site id for analytics attribution on apply. */
  siteId?: string;
  /** Optional initial URL for pre-fill flows. */
  initialUrl?: string;
}

function describeReason(reason: string): string {
  switch (reason) {
    case "invalid_url":
      return "that doesn't look like a Figma file URL. Expected figma.com/file/... or /design/...";
    case "not_configured":
      return "Figma import isn't configured — the operator needs to set FIGMA_ACCESS_TOKEN.";
    case "unauthorized":
      return "Figma rejected the request. The file may be private — make sure the team token has access.";
    case "file_not_found":
      return "Figma couldn't find that file. Check the URL or sharing settings.";
    case "rate_limited":
      return "Figma rate-limited us. Try again in a minute.";
    case "timeout":
      return "Figma took too long to respond. Try again in a moment.";
    case "fetch_failed":
      return "we couldn't reach Figma. It may be offline or the token is wrong.";
    case "empty_result":
      return "we read the file but found nothing frame-like to import.";
    case "role_insufficient":
      return "your account doesn't have permission to import from Figma.";
    default:
      return reason;
  }
}

function appliedCountOf(suggestion: FigmaBriefSuggestion): {
  pages: number;
  themeFields: number;
} {
  const pages = suggestion.pages?.length ?? 0;
  let themeFields = 0;
  if (suggestion.theme?.colors) {
    themeFields += Object.keys(suggestion.theme.colors).length;
  }
  if (suggestion.theme?.font?.family) themeFields += 1;
  return { pages, themeFields };
}

export default function FigmaImporter({
  onApply,
  siteId,
  initialUrl,
}: FigmaImporterProps) {
  const [url, setUrl] = useState<string>(initialUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FigmaImportResult | null>(null);

  const canSubmit = useMemo(() => {
    return url.trim().length > 10 && !loading;
  }, [url, loading]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetchWithRefresh("/api/figma/import", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await r.json().catch(() => null)) as
        | FigmaImportResult
        | null;
      if (!r.ok) {
        const reason =
          (data && "reason" in data && data.reason) || `HTTP ${r.status}`;
        setError(String(reason));
        setResult(null);
        return;
      }
      setResult(data);
      if (data && !data.ok) {
        setError(data.reason);
      }
    } catch (err) {
      setError((err as Error).message || "fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [canSubmit, url]);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const apply = useCallback(() => {
    if (!result?.ok || !result.briefSuggestion) return;
    const suggestion = result.briefSuggestion;
    const counts = appliedCountOf(suggestion);
    onApply(suggestion);
    // Fire-and-forget analytics with the KPI counts — acceptance rate.
    const metadata: Record<string, string | number | boolean> = {
      file_key: result.scraped?.fileKey ?? "",
      applied_pages_count: counts.pages,
      applied_theme_fields: counts.themeFields,
    };
    if (siteId) metadata.site_id = siteId;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "figma_import_applied", metadata }),
    }).catch(() => {});
  }, [onApply, result, siteId]);

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <div
      data-testid="figma-importer"
      style={{
        display: "grid",
        gap: 10,
        padding: 12,
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 6,
        background: "var(--wp-card, rgba(255,255,255,0.03))",
      }}
    >
      <div>
        <h4 style={{ margin: 0, fontSize: 14 }}>Seed from a Figma file</h4>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            color: "var(--wp-text-dim, #a0a8b4)",
          }}
        >
          Paste a Figma file URL. We&apos;ll pull the palette, fonts, and
          frame-to-section layout so you start from the actual design.
        </p>
      </div>
      <form
        onSubmit={onFormSubmit}
        style={{ display: "flex", gap: 6, alignItems: "stretch" }}
      >
        <input
          type="url"
          inputMode="url"
          spellCheck={false}
          placeholder="https://www.figma.com/file/ABC123/…"
          aria-label="Figma file URL"
          data-testid="figma-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          style={{
            flex: 1,
            padding: "8px 10px",
            fontSize: 13,
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 5,
            background: "rgba(0,0,0,0.2)",
            color: "inherit",
          }}
        />
        <button
          type="submit"
          data-testid="figma-url-submit"
          disabled={!canSubmit}
          style={{
            padding: "8px 14px",
            fontSize: 13,
            border: "none",
            borderRadius: 5,
            background: canSubmit
              ? "var(--wp-accent, #f3b841)"
              : "rgba(255,255,255,0.08)",
            color: canSubmit ? "#111" : "rgba(255,255,255,0.4)",
            cursor: canSubmit ? "pointer" : "default",
            fontWeight: 600,
          }}
        >
          {loading ? "Importing…" : "Import from Figma"}
        </button>
      </form>

      {error && !result?.ok && (
        <div
          data-testid="figma-importer-error"
          role="alert"
          style={{
            fontSize: 12,
            color: "#ff9292",
            background: "rgba(255, 80, 80, 0.08)",
            padding: "6px 10px",
            borderRadius: 5,
            border: "1px solid rgba(255, 80, 80, 0.2)",
          }}
        >
          Import failed: {describeReason(error)}
        </div>
      )}

      {result?.ok && result.scraped && result.briefSuggestion && (
        <div
          data-testid="figma-importer-preview"
          style={{
            display: "grid",
            gap: 10,
            padding: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 6,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                data-testid="figma-importer-preview-file"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {result.scraped.fileName || result.scraped.fileKey}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--wp-text-dim, #a0a8b4)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {result.scraped.topLevelFrames.length} frame
                {result.scraped.topLevelFrames.length === 1 ? "" : "s"} ·{" "}
                {result.scraped.colors.length} color
                {result.scraped.colors.length === 1 ? "" : "s"} ·{" "}
                {result.scraped.fonts.length} font
                {result.scraped.fonts.length === 1 ? "" : "s"} ·{" "}
                {result.scraped.latencyMs}ms
              </div>
            </div>
          </div>

          <PaletteRow label="Colors" colors={result.scraped.colors} />

          {result.scraped.fonts.length > 0 && (
            <div
              data-testid="figma-importer-preview-fonts"
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                fontSize: 11,
                color: "var(--wp-text-dim, #a0a8b4)",
              }}
            >
              <span>Fonts:</span>
              {result.scraped.fonts.slice(0, 4).map((f) => (
                <span
                  key={f.family}
                  data-testid="figma-importer-font-chip"
                  style={{
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.06)",
                    color: "inherit",
                    fontFamily: f.family,
                  }}
                >
                  {f.family}
                </span>
              ))}
            </div>
          )}

          {result.scraped.suggestedBriefPages.length > 0 && (
            <div
              data-testid="figma-importer-frames"
              style={{ display: "grid", gap: 4 }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "var(--wp-text-dim, #a0a8b4)",
                }}
              >
                Frames → section hints:
              </div>
              {result.scraped.suggestedBriefPages.slice(0, 6).map((p) => (
                <div
                  key={p.frameId}
                  data-testid="figma-importer-frame-row"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{p.title}</span>
                  <span style={{ color: "var(--wp-text-dim, #a0a8b4)" }}>
                    →
                  </span>
                  <span
                    style={{
                      color: "var(--wp-text-dim, #a0a8b4)",
                      fontFamily: "var(--wp-mono, monospace)",
                    }}
                  >
                    {p.sectionHints.map((s) => s.type).join(", ") || "content"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              data-testid="figma-importer-apply"
              onClick={apply}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                borderRadius: 5,
                background: "rgba(80, 200, 120, 0.16)",
                color: "#6dcf85",
                cursor: "pointer",
              }}
            >
              Apply to this site
            </button>
            <button
              type="button"
              data-testid="figma-importer-reset"
              onClick={reset}
              style={{
                padding: "8px 12px",
                fontSize: 13,
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 5,
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Try another URL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PaletteRow({
  label,
  colors,
}: {
  label: string;
  colors: string[];
}) {
  if (colors.length === 0) return null;
  return (
    <div
      data-testid="figma-importer-palette"
      style={{ display: "flex", gap: 8, alignItems: "center" }}
    >
      <span style={{ fontSize: 11, color: "var(--wp-text-dim, #a0a8b4)" }}>
        {label}
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        {colors.slice(0, 8).map((c) => (
          <span
            key={c}
            data-testid="figma-importer-swatch"
            title={c}
            style={{
              display: "inline-block",
              width: 20,
              height: 20,
              background: c,
              borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
