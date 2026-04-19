"use client";

/**
 * /sites/new — starter-template picker + blank-template option + wireframe
 * drop-to-extract (image/PDF → SiteBrief + theme via /api/sites/parse-brief).
 *
 * Non-technical flow:
 *   1. User types a client slug (same SLUG_RE as POST /api/sites accepts)
 *      OR drops a wireframe image and we pre-fill the slug from the
 *      extracted brief.client.
 *   2. User either:
 *        a) clicks a template card → applyTemplate(id, slug) → POST /api/sites.
 *        b) clicks "Start from blank" → minimal brief → POST /api/sites.
 *        c) drops a wireframe (png/jpg/webp/pdf) → /api/sites/parse-brief
 *           → WireframeExtractReview → user applies → POST /api/sites with
 *           the extracted brief (+theme).
 *   3. On success, fires `site.template_applied` and redirects to
 *      /sites/<id>.
 *
 * Analytics:
 *   - `site.template_previewed` — fired inside <TemplatePicker> on click.
 *   - `site.template_applied` — fired here after POST /api/sites returns
 *     201. Tells the learning loop which template actually got shipped.
 *     For the wireframe path we set templateId = "wireframe" so the
 *     learning loop can distinguish AI-extracted sites from manual picks.
 *   - `site.wireframe_review_*` — fired by WireframeExtractReview.
 *   - `site.wireframe_extraction_failed` — fired here on non-OK parse.
 *
 * Auth:
 *   - Unauthenticated visitors are redirected to /login?next=/sites/new by
 *     the existing (dashboard) layout's guard. We still use
 *     `fetchWithRefresh` for every API call so stale access tokens are
 *     rotated transparently.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import TemplatePicker from "@/components/sites/TemplatePicker";
import MultiFrameUploader from "@/components/sites/MultiFrameUploader";
import WireframeExtractReview, {
  type WireframeExtractPayload,
} from "@/components/sites/WireframeExtractReview";
import { applyTemplate } from "@/lib/site-templates";
import type { SiteBrief } from "@/lib/sites-schema";
import type { SiteTheme } from "@/lib/site-theme";
import { fetchWithRefresh, jsonHeaders, authHeaders } from "@/lib/client-auth";

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;

function blankBrief(clientSlug: string): SiteBrief {
  return {
    client: clientSlug,
    product: {
      name: "New Site",
      tagline: "Short description goes here.",
      domain: `${clientSlug}.com`,
    },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          {
            type: "hero",
            heading: "New Site",
            body: "Edit this brief in Instinct → Sites to populate the rest.",
            cta: { label: "Get in touch", href: "/contact" },
          },
          {
            type: "callout",
            body: "Replace this callout with the first thing you want visitors to do.",
          },
        ],
      },
    ],
    contactForm: { fields: ["name", "email", "message"] },
  };
}

function sanitizeSlugStatic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 39);
}

function parseBriefErrorMessage(status: number, data: { error?: string; reason?: string }): string {
  if (status === 503 || data.reason === "ai_not_configured") {
    return (
      data.error ??
      "AI extraction isn't configured. An admin needs to set ANTHROPIC_API_KEY on this environment."
    );
  }
  if (status === 413) return data.error ?? "Image too large (10 MB max).";
  if (status === 415) {
    return data.error ?? "That file type isn't supported. Try PNG, JPG, WEBP, or PDF.";
  }
  if (data.reason === "too_many_frames") {
    return data.error ?? "Too many frames in one upload (max 10). Remove some and try again.";
  }
  if (data.reason === "unsupported_mime") {
    return data.error ?? "One of the frames isn't a supported format. Use PNG, JPG, WEBP, or PDF.";
  }
  return data.error ?? "Couldn't read that file.";
}

function fireExtractionFailed(reason: string, files: File[]): void {
  const mimes = Array.from(new Set(files.map((f) => f.type))).join(",");
  const sizeBytes = files.reduce((n, f) => n + f.size, 0);
  try {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "site.wireframe_extraction_failed",
        metadata: {
          reason,
          mime: mimes,
          sizeBytes,
          frameCount: files.length,
        },
      }),
    }).catch(() => {});
  } catch { /* swallow */ }
}

export default function NewSitePage() {
  const router = useRouter();
  const [clientSlug, setClientSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wireframe parse state.
  const [parsing, setParsing] = useState(false);
  const [wireframeReview, setWireframeReview] = useState<WireframeExtractPayload | null>(null);
  const [wireframeError, setWireframeError] = useState<string | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);

  function sanitizeSlug(raw: string): string {
    return sanitizeSlugStatic(raw);
  }

  function assertSlugOrReport(): string | null {
    if (!SLUG_RE.test(clientSlug)) {
      setError("Enter a slug first — lowercase letters, numbers, or dashes (e.g. acme-co).");
      return null;
    }
    return clientSlug;
  }

  function fireAppliedAnalytics(templateId: string, slug: string): void {
    try {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          event: "site.template_applied",
          metadata: { template_id: templateId, client_slug: slug },
        }),
      }).catch(() => {});
    } catch {
      /* swallow */
    }
  }

  async function createSite(brief: SiteBrief, templateId: string): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/sites", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ brief }),
      });
      const text = await res.text();
      let data: { project?: { id: string }; error?: string; errors?: string[] } = {};
      try {
        data = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      if (!res.ok) {
        const detail = data.errors?.length ? data.errors.join("; ") : data.error;
        setError(`Create failed (${res.status}): ${detail ?? text.slice(0, 200)}`);
        setSubmitting(false);
        return;
      }
      if (!data.project?.id) {
        setError("Created but no project id returned — please refresh.");
        setSubmitting(false);
        return;
      }
      fireAppliedAnalytics(templateId, brief.client);
      router.push(`/sites/${data.project.id}`);
    } catch (err) {
      setSubmitting(false);
      setError(`Network error: ${(err as Error).message}`);
    }
  }

  async function handleTemplateSelect(templateId: string): Promise<void> {
    const slug = assertSlugOrReport();
    if (!slug) return;
    const applied = applyTemplate(templateId, slug);
    if (!applied) {
      setError(`Unknown template: ${templateId}`);
      return;
    }
    await createSite(applied.brief, templateId);
  }

  async function handleBlank(): Promise<void> {
    const slug = assertSlugOrReport();
    if (!slug) return;
    await createSite(blankBrief(slug), "blank");
  }

  async function handleWireframeFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (parseAbortRef.current) parseAbortRef.current.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setWireframeError(null);
    setWireframeReview(null);
    const fd = new FormData();
    // Back-compat: exactly one file → legacy `file` field so the
    // server single-file path stays hot. Multiple files → `files[]`
    // (API route accepts either for 1 frame, but we keep the legacy
    // name for 1-file uploads so older surfaces stay unchanged).
    if (files.length === 1) {
      fd.append("file", files[0]);
    } else {
      for (const f of files) fd.append("files[]", f);
    }
    // The server accepts an empty clientSlug and will suggest one from the
    // extracted brief. If the user has already typed one, respect it.
    fd.append("clientSlug", clientSlug || "new-site");
    try {
      const r = await fetchWithRefresh("/api/sites/parse-brief", {
        method: "POST",
        headers: authHeaders(),
        body: fd,
        signal: controller.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = parseBriefErrorMessage(r.status, data);
        setWireframeError(msg);
        fireExtractionFailed(data.reason ?? `http_${r.status}`, files);
      } else if (data.source === "vision") {
        setWireframeReview({
          brief: data.brief,
          source: data.source,
          metadata: data.metadata ?? {},
        });
      } else {
        // Non-vision result (shouldn't happen for images but let the user
        // know if the server routed it into a different extractor).
        setWireframeReview({
          brief: data.brief,
          source: data.source,
          metadata: data.metadata ?? {},
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setWireframeError((err as Error).message);
        fireExtractionFailed("network_error", files);
      }
    } finally {
      if (parseAbortRef.current === controller) parseAbortRef.current = null;
      setParsing(false);
    }
  }

  useEffect(() => {
    return () => {
      if (parseAbortRef.current) parseAbortRef.current.abort();
    };
  }, []);

  function applyWireframeExtraction(merged: { brief: SiteBrief; theme: SiteTheme }): void {
    // Pre-fill the slug from the extracted brief when the user hasn't
    // already set one. sanitize again to enforce SLUG_RE invariants — the
    // model could hand back anything for `brief.client`.
    const extractedSlug = sanitizeSlug(merged.brief.client ?? "");
    if (!clientSlug && SLUG_RE.test(extractedSlug)) {
      setClientSlug(extractedSlug);
    }
    // Keep the review mounted with the applied state so the user can
    // still bail out; next they either pick a template or click Create.
    setWireframeReview((prev) =>
      prev ? { ...prev, brief: { ...merged.brief, theme: merged.theme } } : prev,
    );
    setError(null);
  }

  function dismissWireframeExtraction(): void {
    setWireframeReview(null);
  }

  async function handleCreateFromWireframe(): Promise<void> {
    if (!wireframeReview) return;
    const extracted = wireframeReview.brief;
    const slug = assertSlugOrReport();
    if (!slug) return;
    // Ensure the brief carries the user-confirmed slug — the model's
    // suggestion may have been edited by the user before Create.
    const brief: SiteBrief = { ...extracted, client: slug };
    await createSite(brief, "wireframe");
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Start a new site</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          Pick a starter template, start from blank, or drop a wireframe
          image and we&apos;ll suggest colors + sections from it.
        </p>
      </div>

      <div
        style={{
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          borderRadius: "8px",
          padding: "1.5rem",
          marginBottom: "2rem",
          display: "grid",
          gap: "1rem",
          maxWidth: "480px",
        }}
      >
        <div>
          <label
            htmlFor="new-site-slug"
            style={{
              display: "block",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
              marginBottom: "0.3rem",
            }}
          >
            Client slug{" "}
            <span style={{ color: "var(--wp-text-dim)", opacity: 0.7 }}>
              — lowercase letters, numbers, dashes. Used everywhere.
            </span>
          </label>
          <input
            id="new-site-slug"
            data-testid="new-site-slug"
            value={clientSlug}
            onChange={(e) => {
              setClientSlug(sanitizeSlug(e.target.value));
              if (error) setError(null);
            }}
            placeholder="e.g. acme-co"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "0.6rem 0.8rem",
              background: "var(--wp-dark)",
              border: "1px solid var(--wp-border)",
              borderRadius: "6px",
              color: "var(--wp-text)",
              fontSize: "0.95rem",
            }}
          />
        </div>
      </div>

      {/* Wireframe dropzone — drop an image and we extract the brief. */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.4rem 0" }}>
          Start from a wireframe (optional)
        </h2>
        <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", margin: "0 0 0.6rem 0" }}>
          Drop a screenshot or PDF of your wireframe. We&apos;ll read it and
          suggest colors, sections, and a layout you can review before creating
          the site.
        </p>
        <MultiFrameUploader
          label={
            parsing
              ? "Analyzing your wireframe… (usually ~10 seconds)"
              : "Drop one or more wireframe frames (PNG, JPG, WEBP, or PDF)"
          }
          disabled={parsing || submitting}
          onSubmit={handleWireframeFiles}
          testId="wireframe-dropzone"
        />
        {parsing && (
          <div
            data-testid="wireframe-loading-indicator"
            role="status"
            aria-live="polite"
            style={{
              fontSize: "0.8rem",
              color: "var(--wp-text-dim)",
              marginTop: "0.5rem",
            }}
          >
            Analyzing your wireframe… (usually ~10 seconds)
          </div>
        )}
        {wireframeError && (
          <div
            data-testid="wireframe-error-banner"
            role="alert"
            style={{
              padding: "0.6rem 0.8rem",
              marginTop: "0.5rem",
              background: "rgba(220, 80, 80, 0.08)",
              border: "1px solid rgba(220, 80, 80, 0.4)",
              color: "#e07070",
              borderRadius: "6px",
              fontSize: "0.85rem",
            }}
          >
            {wireframeError}
          </div>
        )}
        {wireframeReview && (
          <div style={{ marginTop: "0.75rem" }}>
            <WireframeExtractReview
              payload={wireframeReview}
              onApply={applyWireframeExtraction}
              onDismiss={dismissWireframeExtraction}
            />
            <button
              type="button"
              data-testid="create-from-wireframe"
              onClick={handleCreateFromWireframe}
              disabled={submitting}
              style={{
                marginTop: "0.4rem",
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
                border: "1px solid var(--wp-border)",
                borderRadius: "6px",
                padding: "0.55rem 1rem",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                fontSize: "0.85rem",
              }}
            >
              {submitting ? "Creating site…" : "Create draft from this wireframe"}
            </button>
          </div>
        )}
      </section>

      <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0" }}>Pick a template</h2>
      <TemplatePicker onSelect={handleTemplateSelect} disabled={submitting} />

      <div style={{ marginTop: "1.5rem" }}>
        <button
          type="button"
          data-testid="start-blank"
          onClick={handleBlank}
          disabled={submitting}
          style={{
            background: "transparent",
            color: "var(--wp-text)",
            border: "1px dashed var(--wp-border)",
            padding: "0.6rem 1.2rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Start from blank
        </button>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="new-site-error"
          style={{ color: "#c44", fontSize: "0.9rem", marginTop: "1rem" }}
        >
          {error}
        </div>
      )}

      {submitting && (
        <div
          style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", marginTop: "1rem" }}
        >
          Creating site…
        </div>
      )}
    </div>
  );
}
