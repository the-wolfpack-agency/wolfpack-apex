"use client";

/**
 * SeoFields — per-page SEO editor + site-level defaults + favicon.
 *
 * Controlled component. The parent (detail page or BriefForm) owns the
 * brief and persists on save; this component only bubbles `onChange`
 * with a new SiteBrief. No fetches, no analytics writes — those belong
 * to the caller because save-level analytics (site.seo_updated) should
 * fire once per persist, not once per keystroke.
 *
 * UI:
 *   - Each page is an expandable row showing title / description / OG
 *     image URL / noIndex toggle / canonical.
 *   - Below pages: site-level `defaultSeo` with the same inputs.
 *   - Favicon panel: src URL, monogram input, autoGenerate toggle.
 *
 * Every input has `id` + matching `htmlFor` so a11y is intact.
 */

import { useId, useMemo } from "react";
import type {
  BriefPage,
  PageSeo,
  SiteBrief,
  SiteFavicon,
} from "@/lib/sites-schema";

export interface SeoFieldsProps {
  brief: SiteBrief;
  onChange: (next: SiteBrief) => void;
}

function cloneBrief(brief: SiteBrief): SiteBrief {
  return {
    ...brief,
    product: { ...brief.product },
    pages: brief.pages.map((p) => ({ ...p, seo: p.seo ? { ...p.seo } : undefined })),
    defaultSeo: brief.defaultSeo ? { ...brief.defaultSeo } : undefined,
    favicon: brief.favicon ? { ...brief.favicon } : undefined,
  };
}

/**
 * Produce a new brief with `mutator` applied to `pages[idx].seo`.
 * Undefined fields are stripped so empty strings don't persist and
 * trigger validator length checks on empty values.
 */
function patchPageSeo(
  brief: SiteBrief,
  idx: number,
  mutator: (seo: PageSeo) => PageSeo,
): SiteBrief {
  const next = cloneBrief(brief);
  const page = next.pages[idx];
  const current: PageSeo = page.seo ?? {};
  const patched = mutator({ ...current });
  page.seo = stripEmpty(patched);
  if (!page.seo || Object.keys(page.seo).length === 0) {
    delete page.seo;
  }
  return next;
}

function patchDefaultSeo(
  brief: SiteBrief,
  mutator: (seo: PageSeo) => PageSeo,
): SiteBrief {
  const next = cloneBrief(brief);
  const current: PageSeo = next.defaultSeo ?? {};
  const patched = mutator({ ...current });
  next.defaultSeo = stripEmpty(patched);
  if (!next.defaultSeo || Object.keys(next.defaultSeo).length === 0) {
    delete next.defaultSeo;
  }
  return next;
}

function patchFavicon(
  brief: SiteBrief,
  mutator: (fav: SiteFavicon) => SiteFavicon,
): SiteBrief {
  const next = cloneBrief(brief);
  const current: SiteFavicon = next.favicon ?? {};
  const patched = mutator({ ...current });
  // Preserve booleans explicitly — stripEmpty treats `false` as a value.
  next.favicon = patched;
  return next;
}

/**
 * Drop keys whose values are empty strings. Booleans (including false)
 * are preserved so `noIndex: false` doesn't collapse into `noIndex: true`
 * via the fallback chain.
 */
function stripEmpty(seo: PageSeo): PageSeo {
  const out: PageSeo = {};
  if (typeof seo.title === "string" && seo.title.length > 0) out.title = seo.title;
  if (typeof seo.description === "string" && seo.description.length > 0)
    out.description = seo.description;
  if (typeof seo.ogImage === "string" && seo.ogImage.length > 0)
    out.ogImage = seo.ogImage;
  if (typeof seo.canonical === "string" && seo.canonical.length > 0)
    out.canonical = seo.canonical;
  if (typeof seo.noIndex === "boolean") out.noIndex = seo.noIndex;
  return out;
}

export function SeoFields({ brief, onChange }: SeoFieldsProps) {
  const componentId = useId();
  const pages = useMemo<BriefPage[]>(() => brief.pages ?? [], [brief.pages]);

  return (
    <section
      data-testid="seo-fields"
      className="flex flex-col gap-6 rounded-lg border border-neutral-200 bg-white p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-neutral-900">SEO &amp; favicon</h2>
        <p className="text-sm text-neutral-500">
          Set how pages look when shared on Slack, LinkedIn, or Google. All
          fields are optional — empty pages inherit from the site defaults
          below.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-neutral-800">Per-page SEO</h3>
        {pages.map((page, idx) => (
          <PageSeoRow
            key={page.route ?? idx}
            page={page}
            idx={idx}
            idPrefix={`${componentId}-page-${idx}`}
            onPatch={(mutator) => onChange(patchPageSeo(brief, idx, mutator))}
          />
        ))}
      </div>

      <hr className="border-neutral-200" />

      <div className="flex flex-col gap-4" data-testid="seo-default-panel">
        <h3 className="text-sm font-semibold text-neutral-800">Site-wide defaults</h3>
        <SeoInputs
          value={brief.defaultSeo ?? {}}
          idPrefix={`${componentId}-default`}
          onPatch={(mutator) => onChange(patchDefaultSeo(brief, mutator))}
        />
      </div>

      <hr className="border-neutral-200" />

      <FaviconFields
        value={brief.favicon ?? {}}
        idPrefix={`${componentId}-favicon`}
        onPatch={(mutator) => onChange(patchFavicon(brief, mutator))}
      />
    </section>
  );
}

/* ------------------------------- Sub-components ------------------------ */

function PageSeoRow({
  page,
  idx,
  idPrefix,
  onPatch,
}: {
  page: BriefPage;
  idx: number;
  idPrefix: string;
  onPatch: (mutator: (seo: PageSeo) => PageSeo) => void;
}) {
  return (
    <details
      data-testid={`seo-page-row-${idx}`}
      data-page-route={page.route}
      className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2"
      open={idx === 0}
    >
      <summary className="cursor-pointer text-sm font-medium text-neutral-800">
        {page.title || page.route || `Page ${idx + 1}`}{" "}
        <span className="ml-2 font-mono text-xs text-neutral-500">{page.route}</span>
      </summary>
      <div className="mt-3">
        <SeoInputs value={page.seo ?? {}} idPrefix={idPrefix} onPatch={onPatch} />
      </div>
    </details>
  );
}

function SeoInputs({
  value,
  idPrefix,
  onPatch,
}: {
  value: PageSeo;
  idPrefix: string;
  onPatch: (mutator: (seo: PageSeo) => PageSeo) => void;
}) {
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-description`;
  const ogId = `${idPrefix}-og-image`;
  const noIndexId = `${idPrefix}-noindex`;
  const canonicalId = `${idPrefix}-canonical`;

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={titleId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>Title</span>
        <input
          id={titleId}
          name={titleId}
          type="text"
          maxLength={70}
          value={value.title ?? ""}
          onChange={(e) => onPatch((s) => ({ ...s, title: e.target.value }))}
          placeholder="e.g. Acme — plumbing done right"
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <span className="text-xs text-neutral-500">
          {(value.title ?? "").length}/70 characters
        </span>
      </label>

      <label htmlFor={descId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>Description</span>
        <textarea
          id={descId}
          name={descId}
          rows={2}
          maxLength={170}
          value={value.description ?? ""}
          onChange={(e) => onPatch((s) => ({ ...s, description: e.target.value }))}
          placeholder="Short summary for Google + social shares"
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <span className="text-xs text-neutral-500">
          {(value.description ?? "").length}/170 characters
        </span>
      </label>

      <label htmlFor={ogId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>OG image URL</span>
        <input
          id={ogId}
          name={ogId}
          type="url"
          inputMode="url"
          value={value.ogImage ?? ""}
          onChange={(e) => onPatch((s) => ({ ...s, ogImage: e.target.value }))}
          placeholder="https://…/og.png (1200×630 ideal)"
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>

      <label htmlFor={canonicalId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>Canonical URL</span>
        <input
          id={canonicalId}
          name={canonicalId}
          type="url"
          inputMode="url"
          value={value.canonical ?? ""}
          onChange={(e) => onPatch((s) => ({ ...s, canonical: e.target.value }))}
          placeholder="https://www.example.com/"
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>

      <label
        htmlFor={noIndexId}
        className="flex items-center gap-2 text-sm text-neutral-700"
      >
        <input
          id={noIndexId}
          name={noIndexId}
          type="checkbox"
          checked={value.noIndex === true}
          onChange={(e) => onPatch((s) => ({ ...s, noIndex: e.target.checked }))}
        />
        <span>Hide from Google (noindex)</span>
      </label>
    </div>
  );
}

function FaviconFields({
  value,
  idPrefix,
  onPatch,
}: {
  value: SiteFavicon;
  idPrefix: string;
  onPatch: (mutator: (fav: SiteFavicon) => SiteFavicon) => void;
}) {
  const srcId = `${idPrefix}-src`;
  const monogramId = `${idPrefix}-monogram`;
  const autoId = `${idPrefix}-auto`;

  return (
    <div className="flex flex-col gap-3" data-testid="seo-favicon-panel">
      <h3 className="text-sm font-semibold text-neutral-800">Favicon</h3>
      <p className="text-xs text-neutral-500">
        Give the browser tab + bookmark a recognizable icon. Paste a URL or
        auto-generate one from your brand color + monogram.
      </p>

      <label htmlFor={srcId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>Favicon URL</span>
        <input
          id={srcId}
          name={srcId}
          type="text"
          value={value.src ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onPatch((f) => ({ ...f, src: v.length > 0 ? v : undefined }));
          }}
          placeholder="https://… or /favicon.ico"
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>

      <label htmlFor={monogramId} className="flex flex-col gap-1 text-sm text-neutral-700">
        <span>Monogram (1–2 chars, used when auto-generating)</span>
        <input
          id={monogramId}
          name={monogramId}
          type="text"
          maxLength={2}
          value={value.monogram ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onPatch((f) => ({ ...f, monogram: v.length > 0 ? v : undefined }));
          }}
          placeholder="A"
          className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>

      <label htmlFor={autoId} className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          id={autoId}
          name={autoId}
          type="checkbox"
          checked={value.autoGenerate === true}
          onChange={(e) =>
            onPatch((f) => ({ ...f, autoGenerate: e.target.checked || undefined }))
          }
        />
        <span>Auto-generate from brand color + monogram when no URL is set</span>
      </label>
    </div>
  );
}

export default SeoFields;
