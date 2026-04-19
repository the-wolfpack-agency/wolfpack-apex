"use client";

/**
 * BrandUrlImporter — "seed a site from a real URL" panel.
 *
 * Designer pastes a client's existing public site URL; we POST to
 * /api/brand/scrape; the response contains a mapped `themeSuggestion`.
 * A preview card shows the scraped logo + palette + font sample so the
 * designer can eyeball the result before clicking "Apply to this site."
 *
 * Apply:
 *   - Parent supplies `onApply(suggestion)`. The parent merges the
 *     suggestion into whatever state shape it owns (SiteBrief.theme,
 *     a new-site draft, etc.) and decides when to persist.
 *   - We fire `brand_import_applied` analytics on click with the list
 *     of `applied_fields` that the suggestion contained. That's the
 *     KPI for whether the importer actually helps designers.
 *
 * Auth: every POST goes through `fetchWithRefresh`, not raw fetch, per
 * CLAUDE.md's "no raw authenticated fetches" rule.
 */

import { useCallback, useMemo, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type {
  BrandImportResult,
  BrandThemeSuggestion,
} from "@/lib/brand-url-import";

export interface BrandUrlImporterProps {
  /**
   * Called when the designer clicks "Apply to this site". Parent owns
   * the state shape; we just hand back the suggestion we scraped.
   */
  onApply: (suggestion: BrandThemeSuggestion) => void;
  /**
   * Site id for analytics attribution on apply. Optional — the apply
   * event still fires without it; the KPI aggregation just loses one
   * of its grouping dimensions.
   */
  siteId?: string;
  /**
   * Optional initial URL — useful when the parent wants to pre-fill
   * (e.g. from the client's known domain) so the designer just clicks.
   */
  initialUrl?: string;
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function appliedFieldsOf(suggestion: BrandThemeSuggestion): string[] {
  const out: string[] = [];
  if (suggestion.colors) {
    for (const k of Object.keys(suggestion.colors)) {
      out.push(`colors.${k}`);
    }
  }
  if (suggestion.font?.family) out.push("font.family");
  return out;
}

export default function BrandUrlImporter({
  onApply,
  siteId,
  initialUrl,
}: BrandUrlImporterProps) {
  const [url, setUrl] = useState<string>(initialUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrandImportResult | null>(null);

  const canSubmit = useMemo(() => {
    // Basic check so the Import button is disabled until the designer
    // has typed something that *looks* like a URL. Server re-validates.
    return url.trim().length > 3 && !loading;
  }, [url, loading]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetchWithRefresh("/api/brand/scrape", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await r.json().catch(() => null)) as
        | BrandImportResult
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
    if (!result?.ok || !result.themeSuggestion) return;
    const fields = appliedFieldsOf(result.themeSuggestion);
    onApply(result.themeSuggestion);
    // Fire-and-forget analytics — never block the apply UX on the POST.
    const metadata: Record<string, string | number | boolean> = {
      url_host: safeHost(url),
      applied_fields: fields.join(","),
      field_count: fields.length,
    };
    if (siteId) metadata.site_id = siteId;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "brand_import_applied", metadata }),
    }).catch(() => {});
  }, [onApply, result, siteId, url]);

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <div
      data-testid="brand-url-importer"
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
        <h4 style={{ margin: 0, fontSize: 14 }}>Seed from an existing site</h4>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            color: "var(--wp-text-dim, #a0a8b4)",
          }}
        >
          Paste the client&apos;s current website URL. We&apos;ll extract
          their colors, fonts, and logo so you start on-brand.
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
          placeholder="https://example.com"
          aria-label="Existing site URL"
          data-testid="brand-url-input"
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
          data-testid="brand-url-submit"
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
          {loading ? "Scanning…" : "Import from URL"}
        </button>
      </form>

      {error && !result?.ok && (
        <div
          data-testid="brand-url-error"
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

      {result?.ok && result.scraped && result.themeSuggestion && (
        <div
          data-testid="brand-url-preview"
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
            {(result.scraped.ogImage || result.scraped.faviconUrl) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                data-testid="brand-url-preview-thumb"
                src={
                  result.scraped.ogImage ?? result.scraped.faviconUrl ?? ""
                }
                alt={result.scraped.title ?? "Scraped brand thumbnail"}
                width={64}
                height={64}
                style={{
                  width: 64,
                  height: 64,
                  objectFit: "contain",
                  background: "#fff",
                  borderRadius: 4,
                }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div
                data-testid="brand-url-preview-title"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {result.scraped.title ?? safeHost(result.scraped.url)}
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
                {safeHost(result.scraped.url)} · {result.scraped.latencyMs}ms
              </div>
            </div>
          </div>

          {/* Palette swatches — CSS-derived first, then image-derived */}
          <PaletteRow
            label="Colors"
            colors={uniqueSwatches([
              ...(result.themeSuggestion.colors
                ? Object.values(result.themeSuggestion.colors)
                : []),
              ...result.scraped.cssPalette,
              ...result.scraped.imagePalette,
            ])}
          />

          {/* Font sample — always in the scraped family if we found one */}
          {result.themeSuggestion.font?.family && (
            <div
              data-testid="brand-url-preview-font"
              style={{
                fontSize: 20,
                padding: "6px 10px",
                borderRadius: 5,
                background: "rgba(255,255,255,0.04)",
                fontFamily: result.themeSuggestion.font.family,
              }}
            >
              The quick brown fox — {result.themeSuggestion.font.family}
            </div>
          )}

          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              data-testid="brand-url-apply"
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
              data-testid="brand-url-reset"
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
      data-testid="brand-url-palette"
      style={{ display: "flex", gap: 8, alignItems: "center" }}
    >
      <span style={{ fontSize: 11, color: "var(--wp-text-dim, #a0a8b4)" }}>
        {label}
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        {colors.slice(0, 6).map((c) => (
          <span
            key={c}
            data-testid="brand-url-swatch"
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

function uniqueSwatches(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    if (!c) continue;
    const lc = c.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

function describeReason(reason: string): string {
  switch (reason) {
    case "invalid_url":
      return "that URL isn't valid — check the domain + try again.";
    case "fetch_failed":
      return "we couldn't reach that site (it may be offline or block scrapers).";
    case "timeout":
      return "the site took too long to respond. Try again in a moment.";
    case "html_parse_failed":
      return "we got a response but couldn't read any HTML.";
    case "empty_result":
      return "we read the page but found nothing brand-like to import.";
    case "role_insufficient":
      return "your account doesn't have permission to import brands.";
    default:
      return reason;
  }
}
