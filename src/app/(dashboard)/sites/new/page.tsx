"use client";

/**
 * /sites/new — starter-template picker + blank-template option.
 *
 * Max + Meghan-friendly "pick a template, type a slug, go" flow.
 *
 * Behaviour:
 *   1. User types a client slug (same SLUG_RE as POST /api/sites accepts).
 *   2. User either:
 *      a) clicks a template card → applyTemplate(id, slug) → POST /api/sites.
 *      b) clicks "Start from blank" → minimal brief → POST /api/sites.
 *   3. On success, fires the `site.template_applied` analytics event
 *      (fire-and-forget) and redirects to /sites/<id>.
 *
 * Analytics:
 *   - `site.template_previewed` — fired inside <TemplatePicker> on click.
 *   - `site.template_applied` — fired here after POST /api/sites returns
 *     201. Tells the learning loop which template actually got shipped.
 *
 * Auth:
 *   - Unauthenticated visitors are redirected to /login?next=/sites/new
 *     by the existing (dashboard) layout's guard. We still use
 *     `fetchWithRefresh` for every API call so stale access tokens
 *     are rotated transparently.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import TemplatePicker from "@/components/sites/TemplatePicker";
import { applyTemplate } from "@/lib/site-templates";
import type { SiteBrief } from "@/lib/sites-schema";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

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

export default function NewSitePage() {
  const router = useRouter();
  const [clientSlug, setClientSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function sanitizeSlug(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 39);
  }

  function assertSlugOrReport(): string | null {
    if (!SLUG_RE.test(clientSlug)) {
      setError("Enter a slug first — lowercase letters, numbers, or dashes (e.g. acme-co).");
      return null;
    }
    return clientSlug;
  }

  function fireAppliedAnalytics(templateId: string, slug: string): void {
    // Fire-and-forget. Analytics must never block navigation.
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

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Start a new site</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          Pick a starter template or begin from a blank brief. You can edit every
          section afterwards.
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
