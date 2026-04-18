"use client";

/**
 * Sites preview — live-rendered brief inside an iframe.
 *
 * This page is what the split-screen editor points its `<iframe src>` at.
 * Same-origin means localStorage + Bearer token auth flow through from the
 * parent editor, so no extra session plumbing required.
 *
 * Draft passthrough:
 *   We support `?draft=<base64(JSON)>` so the editor can stream the
 *   in-memory, unsaved brief into the iframe without writing to the DB.
 *   Rationale for the query-param route over a POST draft endpoint:
 *     1. Iframe src changes are the natural trigger — parent just updates
 *        `iframeRef.current.src`; no postMessage / no fetch round-trip.
 *     2. No new API surface → nothing to authorize, rate-limit, or
 *        test on the server side. validateBrief runs here in the browser.
 *     3. Bounded payload: we cap `draft` at 256KB of base64 to avoid
 *        pathological URLs. Real briefs are well under 32KB.
 *   If draft is absent or invalid, we fall back to the saved brief
 *   fetched from GET /api/sites/[id].
 *
 * Chrome note: this page intentionally lives OUTSIDE the (dashboard)
 * route group (moved 2026-04-17) so it renders chrome-less when iframed.
 * Auth is handled client-side below via the same pattern the dashboard
 * layout uses — unauthenticated requests redirect to /login with a next
 * param. Preview API calls go through fetchWithRefresh so the HttpOnly
 * refresh cookie rotates tokens same as the dashboard pages.
 *
 * Analytics: fires `site.preview_viewed` (existing event type) on mount
 * with {project_id, source, brief_section_count}. The spec originally
 * asked for a new `site.preview_loaded` event, but ApexEventType is
 * owned by another agent this cycle — reusing preview_viewed keeps the
 * analytics contract honest and the learning loop unbroken.
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

type PreviewSource = "draft" | "saved";

interface PreviewState {
  brief: SiteBrief | null;
  source: PreviewSource;
  error: string | null;
  loading: boolean;
}

const MAX_DRAFT_BYTES = 256 * 1024;

function decodeDraft(raw: string | null): { brief: SiteBrief | null; error: string | null } {
  if (!raw) return { brief: null, error: null };
  if (raw.length > MAX_DRAFT_BYTES) {
    return { brief: null, error: "Draft too large to preview (>256KB). Save the brief to preview." };
  }
  try {
    // Accept both standard and URL-safe base64. atob rejects URL-safe;
    // normalize first.
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const json = typeof atob === "function"
      ? atob(normalized + pad)
      : Buffer.from(normalized + pad, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    validateBrief(parsed); // throws BriefValidationError on failure
    return { brief: parsed as SiteBrief, error: null };
  } catch (err) {
    const msg = (err as Error).message || "Unknown draft error";
    return { brief: null, error: `Draft could not be rendered: ${msg}` };
  }
}

export default function SitePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const draftRaw = searchParams?.get("draft") ?? null;
  const pageIndex = Number(searchParams?.get("page") ?? "0") || 0;

  const decodedDraft = useMemo(() => decodeDraft(draftRaw), [draftRaw]);

  const [state, setState] = useState<PreviewState>(() => ({
    brief: decodedDraft.brief,
    source: decodedDraft.brief ? "draft" : "saved",
    error: decodedDraft.error,
    loading: decodedDraft.brief === null && decodedDraft.error === null,
  }));

  // Load the saved brief from the server unless we have a valid draft.
  useEffect(() => {
    let cancelled = false;

    async function loadSaved() {
      // If a valid draft is present, skip the network call.
      if (decodedDraft.brief) return;

      const token = getInstinctToken();
      if (!token) {
        // No session → kick to login, preserving where we were for
        // post-login redirect. Matches the rest of the dashboard.
        if (typeof window !== "undefined") {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?next=${next}`;
        }
        return;
      }

      try {
        const res = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) {
          // fetchWithRefresh already redirects on a hard refresh failure.
          return;
        }
        if (res.status === 404) {
          setState({ brief: null, source: "saved", error: "Site not found.", loading: false });
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setState({
            brief: null,
            source: "saved",
            error: data?.error ?? "Failed to load the saved brief.",
            loading: false,
          });
          return;
        }
        setState({
          brief: (data.project?.brief ?? null) as SiteBrief | null,
          source: "saved",
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          brief: null,
          source: "saved",
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

  // Fire preview_viewed analytics event once per mount / source transition.
  useEffect(() => {
    if (state.loading) return;
    if (!state.brief) return;
    const sectionCount = (state.brief.pages ?? []).reduce(
      (n, p) => n + (p.sections?.length ?? 0),
      0,
    );
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "site.preview_viewed",
        metadata: {
          project_id: id,
          source: state.source,
          brief_section_count: sectionCount,
        },
      }),
    }).catch(() => {
      // Fire-and-forget — analytics failure must never blank the preview.
    });
  }, [id, state.loading, state.brief, state.source]);

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

  if (state.error && !state.brief) {
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
      <RenderBrief brief={state.brief} page={pageIndex} />
    </div>
  );
}
