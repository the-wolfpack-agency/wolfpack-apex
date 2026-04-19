"use client";

/**
 * Sites preview — iframed by both /sites/[id] (detail) and
 * /sites/[id]/edit (prompt editor). Three render paths:
 *
 *   1. ?draft=<base64(JSON)>  → RenderBrief of the in-memory draft
 *                               (editor's unsaved pane).
 *   2. no draft, project.preview_url set → iframe the DEPLOYED Vercel
 *                                          URL served by wolfpack-site-
 *                                          template. This is the real
 *                                          styled site a client would
 *                                          see, including content
 *                                          sourced from wireframe
 *                                          uploads that live on the
 *                                          template side (not in
 *                                          SiteBrief).
 *   3. no draft, no preview_url → RenderBrief of the saved brief as a
 *                                  pre-deploy fallback so the editor
 *                                  never blanks.
 *
 * Parity: detail and edit iframes both point here, so whatever decision
 * this page makes renders identically in both surfaces.
 *
 * Analytics: fires `site.preview_viewed` on mount with
 *   { project_id, source, brief_section_count, has_preview_url }
 * `source` is one of "deployed" | "draft" | "fallback_saved" so the
 * learning loop can track how often operators see the real site vs the
 * internal renderer — a signal for template/brief drift health.
 */

import { useEffect, useMemo, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import {
  authHeaders,
  jsonHeaders,
  fetchWithRefresh,
  getInstinctToken,
} from "@/lib/client-auth";
import { validateBrief, type SiteBrief } from "@/lib/sites-schema";
import { RenderBrief } from "@/components/sites/render-brief";
import { buildSeoMetaTags, type SeoMetaTag } from "@/lib/seo-head";

type PreviewSource = "deployed" | "draft" | "fallback_saved";

interface PreviewState {
  brief: SiteBrief | null;
  deployedUrl: string | null;
  source: PreviewSource;
  error: string | null;
  loading: boolean;
}

const MAX_DRAFT_BYTES = 256 * 1024;

export function decodeDraft(raw: string | null): { brief: SiteBrief | null; error: string | null } {
  if (!raw) return { brief: null, error: null };
  if (raw.length > MAX_DRAFT_BYTES) {
    return { brief: null, error: "Draft too large to preview (>256KB). Save the brief to preview." };
  }
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    let json: string;
    if (typeof atob === "function") {
      const bin = atob(normalized + pad);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      json = new TextDecoder("utf-8").decode(bytes);
    } else {
      json = Buffer.from(normalized + pad, "base64").toString("utf-8");
    }
    const parsed = JSON.parse(json) as unknown;
    validateBrief(parsed);
    return { brief: parsed as SiteBrief, error: null };
  } catch (err) {
    const msg = (err as Error).message || "Unknown draft error";
    return { brief: null, error: `Draft could not be rendered: ${msg}` };
  }
}

/**
 * Pure decision: given decoded draft + saved project fields, pick the
 * render path. Exported for unit tests so every branch is locked.
 */
export function selectPreviewSource(args: {
  draftBrief: SiteBrief | null;
  savedBrief: SiteBrief | null;
  previewUrl: string | null;
}): { source: PreviewSource; brief: SiteBrief | null; deployedUrl: string | null } {
  if (args.draftBrief) {
    return { source: "draft", brief: args.draftBrief, deployedUrl: null };
  }
  if (args.previewUrl && args.previewUrl.length > 0) {
    return { source: "deployed", brief: null, deployedUrl: args.previewUrl };
  }
  return { source: "fallback_saved", brief: args.savedBrief, deployedUrl: null };
}

export default function SitePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const draftRaw = searchParams?.get("draft") ?? null;
  const pageIndex = Number(searchParams?.get("page") ?? "0") || 0;

  const decodedDraft = useMemo(() => decodeDraft(draftRaw), [draftRaw]);

  const [state, setState] = useState<PreviewState>(() => {
    if (decodedDraft.brief) {
      return {
        brief: decodedDraft.brief,
        deployedUrl: null,
        source: "draft",
        error: null,
        loading: false,
      };
    }
    return {
      brief: null,
      deployedUrl: null,
      source: "fallback_saved",
      error: decodedDraft.error,
      loading: decodedDraft.error === null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    async function loadSaved() {
      if (decodedDraft.brief) return;

      const token = getInstinctToken();
      if (!token) {
        if (typeof window !== "undefined") {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?next=${next}`;
        }
        return;
      }

      try {
        const res = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) return;
        if (res.status === 404) {
          setState({
            brief: null,
            deployedUrl: null,
            source: "fallback_saved",
            error: "Site not found.",
            loading: false,
          });
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setState({
            brief: null,
            deployedUrl: null,
            source: "fallback_saved",
            error: data?.error ?? "Failed to load the saved brief.",
            loading: false,
          });
          return;
        }
        const savedBrief = (data.project?.brief ?? null) as SiteBrief | null;
        const previewUrl = (data.project?.preview_url ?? null) as string | null;
        const decision = selectPreviewSource({
          draftBrief: null,
          savedBrief,
          previewUrl,
        });
        setState({
          brief: decision.brief,
          deployedUrl: decision.deployedUrl,
          source: decision.source,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          brief: null,
          deployedUrl: null,
          source: "fallback_saved",
          error: (err as Error).message || "Preview request failed.",
          loading: false,
        });
      }
    }

    loadSaved();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, draftRaw]);

  // Analytics: every render path feeds the same event. source + has_preview_url
  // let the brain distinguish (a) how often operators see the real deployed
  // site vs the internal renderer and (b) brief/template drift health.
  useEffect(() => {
    if (state.loading) return;
    if (!state.brief && !state.deployedUrl) return;
    const sectionCount = state.brief
      ? (state.brief.pages ?? []).reduce((n, p) => n + (p.sections?.length ?? 0), 0)
      : 0;
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "site.preview_viewed",
        metadata: {
          project_id: id,
          source: state.source,
          brief_section_count: sectionCount,
          has_preview_url: Boolean(state.deployedUrl),
        },
      }),
    }).catch(() => {});
  }, [id, state.loading, state.brief, state.deployedUrl, state.source]);

  if (state.loading) {
    return (
      <div
        data-testid="preview-loading"
        className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500"
      >
        Loading preview…
      </div>
    );
  }

  if (state.error && !state.brief && !state.deployedUrl) {
    return (
      <div
        data-testid="preview-error"
        className="flex min-h-screen flex-col items-center justify-center gap-2 bg-white p-8 text-center"
      >
        <h2 className="text-lg font-semibold text-neutral-900">Preview unavailable</h2>
        <p className="max-w-md text-sm text-neutral-500">{state.error}</p>
      </div>
    );
  }

  if (state.source === "deployed" && state.deployedUrl) {
    return (
      <iframe
        data-testid="preview-root"
        data-preview-source="deployed"
        src={state.deployedUrl}
        title="Deployed site preview"
        style={{
          display: "block",
          width: "100%",
          height: "100vh",
          border: "none",
          background: "#fff",
        }}
      />
    );
  }

  if (!state.brief) {
    return (
      <div
        data-testid="preview-empty"
        className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-500"
      >
        No brief to preview yet.
      </div>
    );
  }

  return (
    <div data-testid="preview-root" data-preview-source={state.source} className="bg-white">
      <SeoHeadInjector brief={state.brief} pageIndex={pageIndex} />
      <RenderBrief brief={state.brief} page={pageIndex} />
    </div>
  );
}

/**
 * SeoHeadInjector — mounts per-page SEO metadata into `document.head`
 * for the client-rendered preview surface.
 *
 * Why DOM-mutate instead of using Next.js `<head>`: the preview route is
 * a `"use client"` component; Next's metadata API is server-only and the
 * route mounts INSIDE an iframe where SSR metadata doesn't reach this
 * nested document's head. We own the surface, so we inject on mount and
 * clean up on unmount. Tags we own are tagged with
 * `data-instinct-seo="1"` so we never remove the page's pre-existing
 * head children.
 */
export function SeoHeadInjector({
  brief,
  pageIndex,
}: {
  brief: SiteBrief | null;
  pageIndex: number;
}) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!brief) return;
    const previewUrl =
      typeof window !== "undefined" ? window.location.origin : undefined;
    let tags: SeoMetaTag[];
    try {
      tags = buildSeoMetaTags({ brief, pageIndex, previewUrl });
    } catch {
      // Never let SEO injection crash the preview render.
      return;
    }
    const appended: Node[] = [];
    // Remove any previously injected Instinct SEO tags first so we don't
    // pile up duplicates on route changes (e.g., user paginates pages).
    document
      .querySelectorAll('[data-instinct-seo="1"]')
      .forEach((el) => el.parentElement?.removeChild(el));
    for (const descriptor of tags) {
      if (descriptor.tag === "title") {
        // <title> is a singleton; rewrite its text in-place so we don't
        // fight existing title elements.
        let titleEl = document.head.querySelector(
          'title[data-instinct-seo="1"]',
        ) as HTMLTitleElement | null;
        if (!titleEl) {
          titleEl = document.createElement("title");
          titleEl.setAttribute("data-instinct-seo", "1");
          document.head.appendChild(titleEl);
          appended.push(titleEl);
        }
        titleEl.text = descriptor.attrs.text ?? "";
        continue;
      }
      const el = document.createElement(descriptor.tag);
      el.setAttribute("data-instinct-seo", "1");
      for (const [k, v] of Object.entries(descriptor.attrs)) {
        el.setAttribute(k, v);
      }
      document.head.appendChild(el);
      appended.push(el);
    }
    return () => {
      for (const node of appended) {
        node.parentElement?.removeChild(node);
      }
    };
  }, [brief, pageIndex]);
  return null;
}
