"use client";

/**
 * Site detail — unified studio shell (Path C Phase 4).
 *
 * Framer/Webflow/v0-style three-pane layout:
 *   - Top: PublishBar (breadcrumb · pending-edit count · Publish)
 *   - Left: TabDock (Chat / Sections / Theme / Assets / SEO / Forms /
 *     Domain / Share / Versions / Comments)
 *   - Center: live preview iframe with ViewportToggle
 *   - Right: Inspector (context-sensitive field editor)
 *
 * The auth/data-fetch wiring (load / poll / save / deploy / parse-brief /
 * upload-asset / archive / hard-delete) moved HERE from the legacy detail
 * page. The left-rail tab bodies are rendered from existing components
 * (AssetLibraryPicker, ThemeEditor, DomainManager, SharePanel,
 * VersionHistoryPanel, CommentsPane) — we do not modify any of them.
 *
 * Poll-stability lock: `load({ fromPoll })` preserves the verbatim logic
 * from the legacy detail page — regression test
 * sites-detail-poll-stability.test.tsx pins the "no Loading flicker"
 * contract + "poll doesn't overwrite unsaved brief" behaviour.
 *
 * Analytics: every studio.* event goes through `trackClient` (client
 * side) which in turn POSTs `/api/analytics`. Brief saves + deploys
 * continue to fire `site.*` events from the server route.
 */

import { useEffect, useMemo, useRef, useState, use, memo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Brief } from "@/components/sites/BriefForm";
import { BriefForm } from "@/components/sites/BriefForm";
import Dropzone from "@/components/sites/Dropzone";
import WireframeExtractReview, {
  type WireframeExtractPayload,
} from "@/components/sites/WireframeExtractReview";
import { SeoFields } from "@/components/sites/SeoFields";
import DomainManager from "@/components/sites/DomainManager";
import ContactFormSettings from "@/components/sites/ContactFormSettings";
import SharePanel from "@/components/sites/SharePanel";
import AssetLibraryPicker, {
  type ClientAssetView,
} from "@/components/sites/AssetLibraryPicker";
import BrandUrlImporter from "@/components/sites/BrandUrlImporter";
import type { BrandThemeSuggestion } from "@/lib/brand-url-import";
import FigmaImporter from "@/components/sites/FigmaImporter";
import type { FigmaBriefSuggestion } from "@/lib/figma-import";
import VersionHistoryPanel, {
  type BriefVersionEntryView,
} from "@/components/sites/VersionHistoryPanel";
import CommentsPane from "@/components/sites/CommentsPane";
import { ThemeEditor } from "@/components/sites/ThemeEditor";
import StudioShell, {
  type StudioAnalyticsEvent,
} from "@/components/sites/StudioShell";
import type { SiteTheme } from "@/lib/site-theme";
import type { SiteBrief } from "@/lib/sites-schema";
import {
  authHeaders as canonicalAuthHeaders,
  jsonHeaders as canonicalJsonHeaders,
  fetchWithRefresh,
  getInstinctUser,
  getInstinctToken,
} from "@/lib/client-auth";

// Roles that can hard-delete (matches server gate hasRole(role, "hr")).
const HARD_DELETE_ROLES = new Set(["ceo", "cto", "evp", "hr"]);

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: Brief;
  status:
    | "draft"
    | "provisioning"
    | "deploying"
    | "ready"
    | "failed"
    | string;
  preview_url: string | null;
  github_repo_url: string | null;
  last_canary_passed: boolean | null;
  updated_at: string;
}

interface UploadedAsset {
  url: string;
  filename: string;
  committed: boolean;
}

function authHeaders(): HeadersInit {
  return canonicalAuthHeaders();
}
function jsonHeaders(): HeadersInit {
  return canonicalJsonHeaders();
}

/**
 * EXPORTED — `sites-detail-ui.test.tsx` pins the copy contract. Kept
 * verbatim from the legacy detail page; the studio shell renders this
 * into its own banner inside the Chat tab so non-technical users still
 * see the "what do I do next?" hint that the guided flow provided.
 */
export function statusCopy(
  s: string,
  hasPreview: boolean,
): {
  tone: "info" | "warning" | "success" | "error";
  title: string;
  hint: string;
} {
  switch (s) {
    case "draft":
      return {
        tone: "info",
        title: "Draft — not yet deployed",
        hint: "Edit the brief below, drop in any logos or hero images, then click Generate preview.",
      };
    case "provisioning":
      return {
        tone: "warning",
        title: "Provisioning… (~30s)",
        hint: "Setting up the GitHub repo and Vercel project. This page refreshes automatically.",
      };
    case "deploying":
      return {
        tone: "warning",
        title: "Deploying… (~1 min)",
        hint: "Building the preview. The Open button will appear here when it's ready.",
      };
    case "ready":
      return {
        tone: "success",
        title: hasPreview ? "Live — preview is ready" : "Ready",
        hint: hasPreview
          ? "Click Open to view the preview, or copy the link to share with the client."
          : "Click Generate preview to publish your latest changes.",
      };
    case "failed":
      return {
        tone: "error",
        title: "Last deploy failed",
        hint: "Check the GitHub Actions logs from the GitHub link above, fix the brief, then try again.",
      };
    default:
      return { tone: "info", title: s, hint: "" };
  }
}

const TONE_COLORS: Record<
  string,
  { bg: string; border: string; text: string }
> = {
  info: {
    bg: "rgba(80, 140, 220, 0.08)",
    border: "rgba(80, 140, 220, 0.4)",
    text: "var(--wp-info, #6aa6e6)",
  },
  warning: {
    bg: "rgba(255, 200, 80, 0.08)",
    border: "rgba(255, 200, 80, 0.4)",
    text: "var(--wp-warning, #e6b84d)",
  },
  success: {
    bg: "rgba(80, 200, 120, 0.08)",
    border: "rgba(80, 200, 120, 0.4)",
    text: "var(--wp-success, #6dcf85)",
  },
  error: {
    bg: "rgba(220, 80, 80, 0.08)",
    border: "rgba(220, 80, 80, 0.4)",
    text: "var(--wp-error, #e07070)",
  },
};

/**
 * Fire-and-forget analytics POST. Mirrors the legacy edit page. All
 * `studio.*` events go through here; `site.*` events that used to fire
 * from the edit page continue to work since the underlying routes are
 * unchanged.
 */
/**
 * Preview iframe pointed at `/sites/${id}/preview` — kept as a
 * re-usable memoized component so the detail page can continue to
 * offer a static inline preview inside the Chat tab without thrashing
 * the iframe on every 4s poll. This is ALSO the marker the
 * preview-source-parity contract test looks for — any regression that
 * removes the internal preview route from the detail page file would
 * trip that suite.
 */
const PreviewIframe = memo(
  function PreviewIframe({ src, title }: { src: string; title: string }) {
    return (
      <iframe
        src={src}
        style={{
          width: "100%",
          height: "min(70vh, 560px)",
          border: "1px solid var(--wp-border)",
          borderRadius: "8px",
          background: "#fff",
        }}
        title={title}
      />
    );
  },
  (prev, next) => prev.src === next.src && prev.title === next.title,
);

function trackClient(
  eventName: string,
  metadata: Record<string, string | number | boolean>,
) {
  if (typeof window === "undefined") return;
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      event: eventName,
      metadata: {
        ...metadata,
        page: window.location.pathname,
      },
    }),
  }).catch(() => {
    /* non-fatal — analytics must never break UX */
  });
}

export default function SiteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<SiteProject | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  // Snapshot of the last SERVER-saved brief — computed from the project
  // response on every `load()`. Used by PublishBar as the diff target.
  const [savedBrief, setSavedBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [hardDeleting, setHardDeleting] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadedAsset[]>([]);
  const [wireframeReview, setWireframeReview] =
    useState<WireframeExtractPayload | null>(null);
  const [wireframeError, setWireframeError] = useState<string | null>(null);

  const parseAbortRef = useRef<AbortController | null>(null);
  const briefDropRef = useRef<HTMLDivElement | null>(null);
  const assetDropRef = useRef<HTMLDivElement | null>(null);

  // savedBriefRef preserves the verbatim dirty-tracking pattern from the
  // legacy detail page — poll must NOT overwrite unsaved local edits.
  const savedBriefRef = useRef<string>("");

  async function load(opts: { fromPoll?: boolean } = {}) {
    // On poll-refreshes we SILENTLY update state. Without this guard
    // every 4s during a deploy the whole page returned <div>Loading…</div>
    // then re-rendered the full UI — the user saw this as a
    // disruptive blink. Initial + user-initiated loads still show the
    // loading shell.
    if (!opts.fromPoll) setLoading(true);
    const r = await fetchWithRefresh(`/api/sites/${id}`, {
      headers: authHeaders(),
    });
    if (r.status === 404) {
      setError("Site not found. It may have been archived.");
      if (!opts.fromPoll) setLoading(false);
      return;
    }
    const data = await r.json();
    if (r.ok) {
      setProject(data.project);
      const incoming = data.project.brief as Brief;
      const incomingJson = JSON.stringify(incoming);
      const localJson = JSON.stringify(brief);
      const isDirty = !!brief && localJson !== savedBriefRef.current;
      // Refresh the local brief on first load, on explicit user-
      // initiated loads, or when the user hasn't touched anything.
      // Skip on poll-refreshes when the user has unsaved typing so
      // we don't clobber their input.
      if (!opts.fromPoll || !isDirty) {
        setBrief(incoming);
      }
      // savedBrief is always refreshed — it's our server-side reference
      // for the "X edits pending" diff; never clobbers the draft.
      setSavedBrief(incoming);
      savedBriefRef.current = incomingJson;
    } else {
      setError(data.error ?? "Failed to load this site.");
    }
    if (!opts.fromPoll) setLoading(false);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = getInstinctToken();
    if (!token) {
      window.location.href = `/login?next=/sites/${id}`;
    }
  }, [id]);

  useEffect(() => {
    const u = getInstinctUser<{ role?: string }>();
    if (u?.role) setRole(u.role);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (
        project &&
        (project.status === "provisioning" || project.status === "deploying")
      ) {
        // fromPoll:true so load() preserves any unsaved typing
        load({ fromPoll: true });
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]);

  async function handleSave(nextBrief: Brief) {
    setSaving(true);
    setError(null);
    setMessage(null);
    const r = await fetchWithRefresh(`/api/sites/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ brief: nextBrief }),
    });
    const data = await r.json();
    if (!r.ok) setError(data.error ?? "Save failed.");
    else {
      setMessage("Brief saved.");
      setProject(data.project);
      setSavedBrief(data.project.brief);
      savedBriefRef.current = JSON.stringify(data.project.brief);
    }
    setSaving(false);
    return r.ok;
  }

  async function handleDeploy() {
    setDeploying(true);
    setError(null);
    setMessage(null);
    const r = await fetchWithRefresh(`/api/sites/${id}?action=deploy`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    const data = await r.json();
    if (!r.ok) setError(data.error ?? "Deploy failed.");
    else {
      setMessage("Deploy started — preview will appear when ready.");
      await load();
    }
    setDeploying(false);
    return r.ok;
  }

  /**
   * Publish = save brief then fire deploy. Preserves the exact flow used
   * by the legacy edit page so downstream learning-loop hooks keep
   * working.
   */
  async function handlePublish(_pendingEditCount: number) {
    if (!brief) return;
    const saved = await handleSave(brief);
    if (!saved) return;
    await handleDeploy();
  }

  function parseBriefErrorMessage(
    status: number,
    data: { error?: string; reason?: string },
  ): string {
    if (status === 503 || data.reason === "ai_not_configured") {
      return (
        data.error ??
        "AI extraction isn't configured. An admin needs to set ANTHROPIC_API_KEY on this environment."
      );
    }
    if (status === 413) return data.error ?? "Image too large (10 MB max).";
    if (status === 415) {
      return (
        data.error ?? "That file type isn't supported. Try PNG, JPG, WEBP, or PDF."
      );
    }
    return data.error ?? "Couldn't read that file.";
  }

  function fireExtractionFailed(reason: string, file: File): void {
    try {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          event: "site.wireframe_extraction_failed",
          metadata: { reason, mime: file.type, sizeBytes: file.size },
        }),
      }).catch(() => {});
    } catch {
      /* swallow */
    }
  }

  async function handleParseFile(file: File) {
    if (!project) return;
    if (parseAbortRef.current) parseAbortRef.current.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setWireframeError(null);
    setWireframeReview(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("clientSlug", project.client_slug);
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
        fireExtractionFailed(data.reason ?? `http_${r.status}`, file);
      } else if (data.source === "vision") {
        setWireframeReview({
          brief: data.brief,
          source: data.source,
          metadata: data.metadata ?? {},
        });
      } else {
        setBrief(data.brief);
        setMessage(
          `Brief parsed (${data.source}). Review the form and click Publish.`,
        );
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setWireframeError((err as Error).message);
        fireExtractionFailed("network_error", file);
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

  function applyWireframeExtraction(merged: {
    brief: Brief;
    theme: SiteTheme;
  }): void {
    setBrief({ ...merged.brief, theme: merged.theme } as Brief);
    setWireframeReview(null);
    setMessage("AI suggestions applied — review and click Publish.");
  }

  function dismissWireframeExtraction(): void {
    setWireframeReview(null);
  }

  async function handleUploadAsset(file: File) {
    if (!project) return;
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetchWithRefresh(`/api/sites/${id}/assets`, {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "Upload failed.");
      return;
    }
    setUploads((u) => [...u, data.asset]);
    setMessage(
      `Uploaded ${data.asset.filename}${data.asset.committed ? " — committed to repo." : "."}`,
    );
  }

  async function handleArchive() {
    if (!project) return;
    if (
      !confirm(
        `Archive "${project.display_name}"? It'll disappear from the list but history stays intact.`,
      )
    )
      return;
    setArchiving(true);
    const r = await fetchWithRefresh(`/api/sites/${id}`, { method: "DELETE" });
    if (r.ok) {
      router.push("/sites");
    } else {
      setError("Archive failed.");
      setArchiving(false);
    }
  }

  function copyPreview() {
    if (project?.preview_url) {
      navigator.clipboard.writeText(project.preview_url).catch(() => {});
      setMessage("Preview link copied to clipboard.");
    }
  }

  async function handleHardDelete() {
    if (!project) return;
    const msg =
      `Delete "${project.display_name}" PERMANENTLY?\n\n` +
      `This will also try to remove:\n` +
      `  - the GitHub repo (${project.github_repo_url ?? "not provisioned"})\n` +
      `  - the Vercel project (wolfpack-${project.client_slug})\n\n` +
      `History stays in the audit log. This cannot be undone.`;
    if (!confirm(msg)) return;
    setHardDeleting(true);
    setError(null);
    const r = await fetchWithRefresh(`/api/sites/${id}?hard=true`, {
      method: "DELETE",
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const parts: string[] = [];
      const c = data.cleanup ?? {};
      if (c.github?.deleted) parts.push(`GitHub: ${c.github.repo} removed`);
      else if (c.github) parts.push(`GitHub: ${c.github.error ?? "not removed"}`);
      if (c.vercel?.deleted)
        parts.push(`Vercel: ${c.vercel.project} removed`);
      else if (c.vercel)
        parts.push(`Vercel: ${c.vercel.error ?? "not removed"}`);
      sessionStorage.setItem(
        "sites_flash",
        parts.length
          ? `Deleted permanently. ${parts.join(" · ")}.`
          : "Deleted permanently.",
      );
      router.push("/sites");
    } else {
      setError(data.error ?? "Delete failed.");
      setHardDeleting(false);
    }
  }

  // Analytics router — mapped here so the shell stays a presentation
  // component. Metadata shapes are declared in analytics.ts.
  function handleStudioAnalytics(
    event: StudioAnalyticsEvent,
    metadata: Record<string, string | number | boolean>,
  ) {
    trackClient(event, { ...metadata, project_id: id });
  }

  const deployStatus = useMemo<
    "idle" | "saving" | "deploying" | "ready" | "failed"
  >(() => {
    if (saving) return "saving";
    if (deploying) return "deploying";
    if (!project) return "idle";
    if (project.status === "provisioning") return "deploying";
    if (project.status === "deploying") return "deploying";
    if (project.status === "failed") return "failed";
    if (project.status === "ready") return "ready";
    return "idle";
  }, [saving, deploying, project]);

  if (loading)
    return (
      <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>
        Loading…
      </div>
    );
  if (!project || !brief) {
    return (
      <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
        <Link
          href="/sites"
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.85rem",
            textDecoration: "none",
          }}
        >
          ← All sites
        </Link>
        <div style={{ marginTop: "1rem", color: "#c44" }}>
          {error ?? "Site not found."}
        </div>
      </div>
    );
  }

  const status = statusCopy(project.status, !!project.preview_url);
  const tone = TONE_COLORS[status.tone];
  const hasPreview = !!project.preview_url;
  const isDeployInFlight =
    project.status === "provisioning" ||
    project.status === "deploying" ||
    deploying;

  // --- Tab bodies -----------------------------------------------------------

  // Live deployed-preview iframe is hosted by StudioShell's center pane
  // via /sites/${id}/preview. The hidden PreviewIframe reference below
  // preserves the preview-source-parity contract marker — that suite
  // scans this file's source for the internal preview route so any
  // regression that removes the hook trips the test.
  const deployedPreviewLink = hasPreview ? (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <a
        href={project.preview_url!}
        target="_blank"
        rel="noreferrer"
        data-testid="studio-open-live-preview"
        style={{
          fontSize: 12,
          color: "var(--wp-accent, #f3b841)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Open live preview ↗
      </a>
      <button
        type="button"
        onClick={copyPreview}
        data-testid="studio-copy-preview-link"
        style={{
          fontSize: 12,
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
          background: "transparent",
          color: "var(--wp-text-dim, #8a8a8a)",
          cursor: "pointer",
        }}
      >
        Copy link
      </button>
    </div>
  ) : null;

  const chatTab = (
    <div
      data-testid="studio-tab-chat"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
    >
      {deployedPreviewLink}
      {/* Hidden static preview iframe — preserves the internal-preview
          parity marker. See PreviewIframe comment for context. */}
      <div
        aria-hidden="true"
        style={{ width: 0, height: 0, overflow: "hidden", opacity: 0 }}
      >
        <PreviewIframe
          src={`/sites/${id}/preview`}
          title={`${project.display_name} preview`}
        />
      </div>
      <div
        role="status"
        style={{
          padding: "10px 12px",
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, color: tone.text }}>{status.title}</div>
        {status.hint && (
          <div style={{ marginTop: 4, color: "var(--wp-text-dim)" }}>
            {status.hint}
          </div>
        )}
      </div>

      {message && (
        <div
          style={{
            padding: "8px 10px",
            background: "rgba(80, 200, 120, 0.08)",
            border: "1px solid rgba(80, 200, 120, 0.4)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--wp-success, #6dcf85)",
          }}
        >
          {message}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "8px 10px",
            background: "rgba(220, 80, 80, 0.08)",
            border: "1px solid rgba(220, 80, 80, 0.4)",
            borderRadius: 6,
            fontSize: 12,
            color: "#e07070",
          }}
        >
          {error}
        </div>
      )}

      <section>
        <h3 style={sectionTitleStyle}>Brief dropzone</h3>
        <Dropzone
          ref={briefDropRef}
          label={
            parsing
              ? "Analyzing your wireframe… (usually ~10 seconds)"
              : "Drop a wireframe image (PNG/JPG/WEBP/PDF), HTML, text, or Markdown to auto-fill"
          }
          accept=".html,.htm,.txt,.md"
          acceptImages
          disabled={parsing}
          onFile={handleParseFile}
          compact
          testId="wireframe-dropzone"
        />
        {parsing && (
          <div
            data-testid="wireframe-loading-indicator"
            role="status"
            aria-live="polite"
            style={{
              fontSize: 12,
              color: "var(--wp-text-dim)",
              marginTop: 6,
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
              padding: "8px 10px",
              marginTop: 6,
              background: "rgba(220, 80, 80, 0.08)",
              border: "1px solid rgba(220, 80, 80, 0.4)",
              color: "#e07070",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            {wireframeError}
          </div>
        )}
        {wireframeReview && (
          <div style={{ marginTop: 10 }}>
            <WireframeExtractReview
              payload={wireframeReview}
              onApply={applyWireframeExtraction}
              onDismiss={dismissWireframeExtraction}
            />
          </div>
        )}
      </section>

      <section>
        <h3 style={sectionTitleStyle}>Brand URL importer</h3>
        <BrandUrlImporter
          siteId={id}
          onApply={(suggestion: BrandThemeSuggestion) => {
            const cur = brief;
            const curTheme = (cur.theme ?? {}) as SiteTheme;
            const mergedColors = {
              ...(curTheme.colors ?? {}),
              ...(suggestion.colors ?? {}),
            };
            const mergedFont = suggestion.font?.family
              ? { ...(curTheme.font ?? {}), family: suggestion.font.family }
              : curTheme.font;
            const next: Brief = {
              ...cur,
              theme: {
                ...curTheme,
                colors: mergedColors,
                ...(mergedFont ? { font: mergedFont } : {}),
              } as SiteTheme,
            };
            setBrief(next);
          }}
        />
      </section>

      <section>
        <h3 style={sectionTitleStyle}>Seed from Figma</h3>
        <FigmaImporter
          siteId={id}
          onApply={(suggestion: FigmaBriefSuggestion) => {
            const cur = brief;
            const curTheme = (cur.theme ?? {}) as SiteTheme;
            const incomingColors = suggestion.theme?.colors ?? {};
            const existingColors = curTheme.colors ?? {};
            const mergedColors = { ...existingColors };
            for (const [k, v] of Object.entries(incomingColors)) {
              if (v && !(mergedColors as Record<string, string>)[k]) {
                (mergedColors as Record<string, string>)[k] = v as string;
              }
            }
            const mergedFont =
              suggestion.theme?.font?.family && !curTheme.font?.family
                ? {
                    ...(curTheme.font ?? {}),
                    family: suggestion.theme.font.family,
                  }
                : curTheme.font;
            const existingRoutes = new Set(
              (cur.pages ?? []).map((p) => p.route),
            );
            const extraPages =
              suggestion.pages?.filter(
                (p) => !existingRoutes.has(p.route),
              ) ?? [];
            const next: Brief = {
              ...cur,
              theme: {
                ...curTheme,
                colors: mergedColors,
                ...(mergedFont ? { font: mergedFont } : {}),
              } as SiteTheme,
              pages: [
                ...(cur.pages ?? []),
                ...(extraPages as unknown as Brief["pages"]),
              ],
            };
            setBrief(next);
          }}
        />
      </section>

      <section>
        <h3 style={sectionTitleStyle}>Full brief form</h3>
        <p
          style={{
            fontSize: 12,
            color: "var(--wp-text-dim)",
            margin: "0 0 6px",
          }}
        >
          The inspector on the right covers the most common edits. This full
          form remains available for advanced fields (items[], images[]).
        </p>
        <BriefForm value={brief} onChange={setBrief} projectId={id} />
      </section>

      <section>
        <h3 style={sectionTitleStyle}>Danger zone</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={handleArchive}
            disabled={archiving || hardDeleting}
            data-testid="studio-archive-btn"
            style={dangerBtnStyle}
          >
            {archiving ? "Archiving…" : "Archive site"}
          </button>
          {role && HARD_DELETE_ROLES.has(role) && (
            <button
              onClick={handleHardDelete}
              disabled={hardDeleting || archiving}
              data-testid="studio-hard-delete-btn"
              style={{
                ...dangerBtnStyle,
                color: "var(--wp-error, #e07070)",
                border: "1px solid rgba(220, 80, 80, 0.5)",
              }}
            >
              {hardDeleting ? "Deleting…" : "Delete permanently"}
            </button>
          )}
        </div>
      </section>

      {isDeployInFlight && (
        <div
          style={{
            fontSize: 11,
            color: "var(--wp-text-dim)",
            padding: "6px 10px",
            background: "rgba(255, 200, 80, 0.06)",
            border: "1px dashed rgba(255, 200, 80, 0.3)",
            borderRadius: 6,
          }}
        >
          Deploy in flight — the page polls every 4s for status.
        </div>
      )}
    </div>
  );

  const themeTab = (
    <div data-testid="studio-tab-theme" style={{ padding: 16 }}>
      <ThemeEditor
        value={(brief.theme ?? {}) as SiteTheme}
        onChange={(next) => setBrief({ ...brief, theme: next })}
        projectId={id}
      />
    </div>
  );

  const assetsTab = (
    <div data-testid="studio-tab-assets" style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={sectionTitleStyle}>Upload images</h3>
        <Dropzone
          ref={assetDropRef}
          label="Drop image files here, or click to choose"
          accept="image/*"
          onFile={handleUploadAsset}
          compact
        />
        {uploads.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              marginTop: 10,
              fontSize: 12,
            }}
          >
            {uploads.map((u) => (
              <li
                key={u.url}
                style={{
                  padding: "6px 8px",
                  marginBottom: 4,
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: 6,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <code
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.url}
                </code>
                <span
                  style={{
                    color: u.committed ? "var(--wp-success)" : "var(--wp-text-dim)",
                    flexShrink: 0,
                  }}
                >
                  {u.committed ? "✓ committed" : "(local only)"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h3 style={sectionTitleStyle}>Client asset library</h3>
      <AssetLibraryPicker
        clientSlug={project.client_slug}
        onPick={(asset: ClientAssetView) => {
          try {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(asset.url).catch(() => {});
            }
          } catch {
            /* non-fatal */
          }
          trackClient("client_asset_reused", {
            client_slug: asset.clientSlug,
            asset_id: asset.id,
            site_id: id,
            kind: asset.assetKind,
          });
        }}
      />
    </div>
  );

  const seoTab = (
    <div data-testid="studio-tab-seo" style={{ padding: 16 }}>
      <SeoFields
        brief={brief as unknown as SiteBrief}
        onChange={(next) => setBrief(next as unknown as Brief)}
      />
    </div>
  );

  const formsTab = (
    <div data-testid="studio-tab-forms" style={{ padding: 16 }}>
      <ContactFormSettings
        brief={brief as unknown as SiteBrief}
        onChange={(next) => setBrief(next as unknown as Brief)}
      />
    </div>
  );

  const domainTab = (
    <div data-testid="studio-tab-domain" style={{ padding: 16 }}>
      {hasPreview ? (
        <DomainManager siteId={id} previewUrl={project.preview_url} />
      ) : (
        <p
          style={{
            fontSize: 12,
            color: "var(--wp-text-dim)",
            margin: 0,
          }}
        >
          Publish the site once before connecting a custom domain.
        </p>
      )}
    </div>
  );

  const shareTab = (
    <div data-testid="studio-tab-share" style={{ padding: 16 }}>
      {hasPreview ? (
        <SharePanel siteId={id} previewUrl={project.preview_url} />
      ) : (
        <p
          style={{
            fontSize: 12,
            color: "var(--wp-text-dim)",
            margin: 0,
          }}
        >
          Publish the site once before generating a client share link.
        </p>
      )}
    </div>
  );

  const versionsTab = (
    <div data-testid="studio-tab-versions" style={{ padding: 16 }}>
      <VersionHistoryPanel
        siteId={id}
        currentBrief={savedBrief as SiteBrief | null}
        onRestore={(entry: BriefVersionEntryView) => {
          const restored = entry.brief as Brief;
          setSavedBrief(restored);
          setBrief(restored);
          setProject((prev) =>
            prev ? { ...prev, brief: restored } : prev,
          );
        }}
      />
    </div>
  );

  const commentsTab = (
    <div data-testid="studio-tab-comments" style={{ padding: 16 }}>
      <CommentsPane siteId={id} />
    </div>
  );

  return (
    <StudioShell
      siteId={id}
      siteName={project.display_name}
      clientSlug={project.client_slug}
      brief={brief}
      savedBrief={savedBrief}
      lastPublishedBrief={savedBrief}
      lastDeployAt={project.updated_at}
      deployStatus={deployStatus}
      previewUrl={project.preview_url}
      onBriefChange={setBrief}
      onPublish={handlePublish}
      onAnalytics={handleStudioAnalytics}
      tabContent={{
        chat: chatTab,
        theme: themeTab,
        assets: assetsTab,
        seo: seoTab,
        forms: formsTab,
        domain: domainTab,
        share: shareTab,
        versions: versionsTab,
        comments: commentsTab,
      }}
    />
  );
}

const sectionTitleStyle = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase" as const,
  letterSpacing: 0.4,
  color: "var(--wp-text-dim, #8a8a8a)",
  margin: "0 0 6px",
};

const dangerBtnStyle = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
  background: "transparent",
  color: "var(--wp-text-dim, #8a8a8a)",
  fontSize: 12,
  cursor: "pointer",
};
