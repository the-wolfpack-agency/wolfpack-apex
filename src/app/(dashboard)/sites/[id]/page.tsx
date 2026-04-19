"use client";

/**
 * Site detail — guided editor for non-technical users (Max, Meghan).
 *
 * Vertical, single-column flow with a status banner that tells the user
 * exactly what to do next. Mobile-first: collapses cleanly, no horizontal
 * scroll. Preview shows up below the brief once a deploy has succeeded;
 * before that, the deploy CTA is the visual anchor.
 *
 * Drop targets:
 *   1. Brief dropzone — drop HTML/PDF/docx → /api/sites/parse-brief →
 *      replaces the brief, the user reviews/saves.
 *   2. Asset dropzone — drop images → /api/sites/[id]/assets → uploads
 *      and commits to the client repo, returns a copy-pasteable URL.
 *   3. Generate preview button → triggers a deploy.
 *
 * Polls every 4s while a deploy is in flight so the iframe + Open button
 * appear automatically when the webhook reports back.
 */

import { useEffect, useState, useRef, use, memo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BriefForm, type Brief } from "@/components/sites/BriefForm";
import Dropzone from "@/components/sites/Dropzone";
import WireframeExtractReview, {
  type WireframeExtractPayload,
} from "@/components/sites/WireframeExtractReview";
import { SeoFields } from "@/components/sites/SeoFields";
import DomainManager from "@/components/sites/DomainManager";
import type { SiteTheme } from "@/lib/site-theme";
import type { SiteBrief } from "@/lib/sites-schema";
import {
  authHeaders as canonicalAuthHeaders,
  jsonHeaders as canonicalJsonHeaders,
  fetchWithRefresh,
  getInstinctUser,
} from "@/lib/client-auth";

// Roles that can hard-delete (matches server gate hasRole(role, "hr")).
const HARD_DELETE_ROLES = new Set(["ceo", "cto", "hr"]);

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: Brief;
  status: "draft" | "provisioning" | "deploying" | "ready" | "failed" | string;
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

// Preview iframe extracted + memoized. The parent re-renders every 4s
// while a deploy is in flight (status poll). Without memoization the
// iframe's parent JSX re-evaluates, React reconciles the iframe props,
// and in some reconciliation paths the iframe reloads — each reload
// re-requests every asset inside the deployed site, so a stale preview
// with broken image paths would rack up the same 404s across hundreds
// of polls. memo + a stable comparator on `src` alone keeps the iframe
// mounted until the URL actually changes.
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

export function statusCopy(s: string, hasPreview: boolean): { tone: "info" | "warning" | "success" | "error"; title: string; hint: string } {
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

const TONE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  info: { bg: "rgba(80, 140, 220, 0.08)", border: "rgba(80, 140, 220, 0.4)", text: "var(--wp-info, #6aa6e6)" },
  warning: { bg: "rgba(255, 200, 80, 0.08)", border: "rgba(255, 200, 80, 0.4)", text: "var(--wp-warning, #e6b84d)" },
  success: { bg: "rgba(80, 200, 120, 0.08)", border: "rgba(80, 200, 120, 0.4)", text: "var(--wp-success, #6dcf85)" },
  error: { bg: "rgba(220, 80, 80, 0.08)", border: "rgba(220, 80, 80, 0.4)", text: "var(--wp-error, #e07070)" },
};

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<SiteProject | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
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
  // Wireframe review — populated once a vision extraction succeeds.
  // Null hides the review card; user dismissing it also clears this.
  const [wireframeReview, setWireframeReview] = useState<WireframeExtractPayload | null>(null);
  // Wireframe-specific error — kept separate from the page-wide `error`
  // state so save/deploy errors don't bleed into the brief section's
  // wireframe-error-banner (and vice versa).
  const [wireframeError, setWireframeError] = useState<string | null>(null);
  // AbortController for an in-flight parse-brief call. Lets us cancel
  // when the component unmounts mid-request so the "Parsing…" state
  // doesn't wedge forever.
  const parseAbortRef = useRef<AbortController | null>(null);
  const briefDropRef = useRef<HTMLDivElement | null>(null);
  const assetDropRef = useRef<HTMLDivElement | null>(null);

  // Track the server's last-known brief so we can detect unsaved edits
  // (localBrief diverges from savedBriefRef when the user has typed).
  // The poll must NOT overwrite an unsaved brief — without this the
  // form flickers back to the last-saved value every 4s while a deploy
  // is in flight, visibly clobbering whatever the user is typing.
  const savedBriefRef = useRef<string>("");

  async function load(opts: { fromPoll?: boolean } = {}) {
    // On poll-refreshes we SILENTLY update state. Without this guard
    // every 4s during a deploy the whole page returned <div>Loading…</div>
    // then re-rendered the full UI — the user saw this as a
    // disruptive blink. Initial + user-initiated loads still show the
    // loading shell.
    if (!opts.fromPoll) setLoading(true);
    const r = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
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
      savedBriefRef.current = incomingJson;
    } else {
      setError(data.error ?? "Failed to load this site.");
    }
    if (!opts.fromPoll) setLoading(false);
  }

  useEffect(() => {
    const u = getInstinctUser<{ role?: string }>();
    if (u?.role) setRole(u.role);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (project && (project.status === "provisioning" || project.status === "deploying")) {
        // fromPoll:true so load() preserves any unsaved typing
        load({ fromPoll: true });
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]);

  async function handleSave() {
    if (!brief) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const r = await fetchWithRefresh(`/api/sites/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ brief }),
    });
    const data = await r.json();
    if (!r.ok) setError(data.error ?? "Save failed.");
    else {
      setMessage("Brief saved.");
      setProject(data.project);
    }
    setSaving(false);
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
  }

  function parseBriefErrorMessage(status: number, data: { error?: string; reason?: string }): string {
    // Surface the server's exact message where provided, but add actionable
    // copy for the known failure modes Max/Meghan might hit.
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
    } catch { /* swallow */ }
  }

  async function handleParseFile(file: File) {
    if (!project) return;
    // Cancel any in-flight parse when the user drops a new file.
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
        // Image/PDF path — show the review card, DON'T auto-apply. The user
        // confirms before the extracted brief lands in BriefForm state.
        setWireframeReview({
          brief: data.brief,
          source: data.source,
          metadata: data.metadata ?? {},
        });
      } else {
        // Text/HTML/Markdown path keeps the legacy behavior — the brief
        // drops straight into the form.
        setBrief(data.brief);
        setMessage(`Brief parsed (${data.source}). Review the form below and click Save.`);
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

  // Clean up any in-flight parse request when the page unmounts so
  // the fetch doesn't resolve into a destroyed component.
  useEffect(() => {
    return () => {
      if (parseAbortRef.current) parseAbortRef.current.abort();
    };
  }, []);

  function applyWireframeExtraction(merged: { brief: Brief; theme: SiteTheme }): void {
    setBrief({ ...merged.brief, theme: merged.theme } as Brief);
    setWireframeReview(null);
    setMessage("AI suggestions applied — review the form below and click Save.");
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
    setMessage(`Uploaded ${data.asset.filename}${data.asset.committed ? " — committed to repo." : "."}`);
  }

  async function handleArchive() {
    if (!project) return;
    if (!confirm(`Archive "${project.display_name}"? It'll disappear from the list but history stays intact.`)) return;
    setArchiving(true);
    const r = await fetchWithRefresh(`/api/sites/${id}`, { method: "DELETE" });
    if (r.ok) {
      router.push("/sites");
    } else {
      setError("Archive failed.");
      setArchiving(false);
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
    const r = await fetchWithRefresh(`/api/sites/${id}?hard=true`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const parts: string[] = [];
      const c = data.cleanup ?? {};
      if (c.github?.deleted) parts.push(`GitHub: ${c.github.repo} removed`);
      else if (c.github) parts.push(`GitHub: ${c.github.error ?? "not removed"}`);
      if (c.vercel?.deleted) parts.push(`Vercel: ${c.vercel.project} removed`);
      else if (c.vercel) parts.push(`Vercel: ${c.vercel.error ?? "not removed"}`);
      sessionStorage.setItem(
        "sites_flash",
        parts.length ? `Deleted permanently. ${parts.join(" · ")}.` : "Deleted permanently.",
      );
      router.push("/sites");
    } else {
      setError(data.error ?? "Delete failed.");
      setHardDeleting(false);
    }
  }

  function copyPreview() {
    if (project?.preview_url) {
      navigator.clipboard.writeText(project.preview_url);
      setMessage("Preview link copied to clipboard.");
    }
  }

  if (loading) return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  if (!project || !brief) {
    return (
      <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
        <Link href="/sites" style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}>
          ← All sites
        </Link>
        <div style={{ marginTop: "1rem", color: "#c44" }}>{error ?? "Site not found."}</div>
      </div>
    );
  }

  const status = statusCopy(project.status, !!project.preview_url);
  const tone = TONE_COLORS[status.tone];
  const isDeployInFlight = project.status === "provisioning" || project.status === "deploying" || deploying;
  const hasPreview = !!project.preview_url;

  return (
    <div style={{ maxWidth: "880px", margin: "0 auto", padding: "1.25rem 1rem 3rem", color: "var(--wp-text)" }}>
      {/* Breadcrumb + archive */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", gap: "0.5rem" }}>
        <Link href="/sites" style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}>
          ← All sites
        </Link>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        {role && HARD_DELETE_ROLES.has(role) && (
          <button
            onClick={handleHardDelete}
            disabled={hardDeleting || archiving}
            style={{
              background: "transparent",
              color: "var(--wp-error, #e07070)",
              border: "1px solid rgba(220, 80, 80, 0.5)",
              padding: "0.35rem 0.75rem",
              borderRadius: "6px",
              fontSize: "0.75rem",
              cursor: hardDeleting ? "wait" : "pointer",
            }}
            aria-label="Delete permanently"
          >
            {hardDeleting ? "Deleting…" : "Delete permanently"}
          </button>
        )}
        <button
          onClick={handleArchive}
          disabled={archiving || hardDeleting}
          style={{
            background: "transparent",
            color: "var(--wp-text-dim)",
            border: "1px solid var(--wp-border)",
            padding: "0.35rem 0.75rem",
            borderRadius: "6px",
            fontSize: "0.75rem",
            cursor: archiving ? "wait" : "pointer",
          }}
          aria-label="Archive site"
        >
          {archiving ? "Archiving…" : "Archive site"}
        </button>
        </div>
      </div>

      {/* Header */}
      <h1 style={{ fontSize: "1.6rem", margin: "0.25rem 0", lineHeight: 1.2 }}>{project.display_name}</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", color: "var(--wp-text-dim)", fontSize: "0.85rem", marginBottom: "1.25rem" }}>
        <span>{project.client_slug}</span>
        {project.github_repo_url && (
          <>
            <span aria-hidden>·</span>
            <a href={project.github_repo_url} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold)" }}>
              GitHub repo ↗
            </a>
          </>
        )}
      </div>

      {/* Status banner — tells the user what to do next */}
      <div
        role="status"
        style={{
          padding: "0.85rem 1rem",
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          borderRadius: "8px",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ fontWeight: 600, color: tone.text, fontSize: "0.95rem" }}>{status.title}</div>
        {status.hint && (
          <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "0.25rem" }}>{status.hint}</div>
        )}
      </div>

      {/* Live preview — renders the current SAVED brief through Instinct's
          internal /sites/[id]/preview route so this iframe ALWAYS matches
          the /sites/[id]/edit preview iframe exactly. "Open ↗" + "Copy
          link" still point at the deployed Vercel URL when a deploy has
          succeeded, so operators can share the true production URL.
          Before the first deploy, those buttons hide. */}
      <section style={{ marginBottom: "2rem" }} data-testid="detail-preview-section">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <h2 style={{ fontSize: "1.05rem", margin: 0 }}>Preview</h2>
          {hasPreview && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <a
                href={project.preview_url!}
                target="_blank"
                rel="noreferrer"
                style={{ ...btnStyle("var(--wp-gold)"), display: "inline-block", textDecoration: "none", textAlign: "center" }}
              >
                Open ↗
              </a>
              <button onClick={copyPreview} style={btnStyle()}>Copy link</button>
            </div>
          )}
        </div>
        <PreviewIframe
          src={`/sites/${id}/preview`}
          title={`${project.display_name} preview`}
        />
      </section>

      {/* Step 1 — Brief */}
      <section style={{ marginBottom: "2rem" }}>
        <SectionHeading step="1" title="Edit the brief" />
        <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
          Update the content for the site. Save when you&apos;re happy — that doesn&apos;t deploy yet.
        </p>
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
          </div>
        )}
        <div style={{ marginTop: "1rem" }}>
          <BriefForm value={brief} onChange={setBrief} />
        </div>
        {/* SEO + favicon editor — feeds the same brief state; Save brief persists
            everything in one round-trip. SiteBrief's SEO/favicon fields are all
            optional so legacy briefs (no SEO keys) keep validating green. */}
        <div style={{ marginTop: "1.25rem" }}>
          <SeoFields
            brief={brief as unknown as SiteBrief}
            onChange={(next) => setBrief(next as unknown as Brief)}
          />
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button onClick={handleSave} disabled={saving} style={btnStyle()}>
            {saving ? "Saving…" : "Save brief"}
          </button>
        </div>
      </section>

      {/* Step 2 — Assets */}
      <section style={{ marginBottom: "2rem" }}>
        <SectionHeading step="2" title="Upload images (optional)" />
        <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
          Logos, hero photos, anything you want on the site. Drop them in and copy the URL into the brief above.
        </p>
        <Dropzone
          ref={assetDropRef}
          label="Drop image files here, or click to choose"
          accept="image/*"
          onFile={handleUploadAsset}
          compact
        />
        {uploads.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "0.75rem", fontSize: "0.8rem" }}>
            {uploads.map((u) => (
              <li
                key={u.url}
                style={{ padding: "0.5rem 0.75rem", marginBottom: "0.4rem", background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}
              >
                <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.url}</code>
                <span style={{ color: u.committed ? "var(--wp-success)" : "var(--wp-text-dim)", flexShrink: 0 }}>
                  {u.committed ? "✓ committed" : "(local only)"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Step 3 — Deploy */}
      <section style={{ marginBottom: "2rem" }}>
        <SectionHeading step="3" title={hasPreview ? "Re-deploy with your latest changes" : "Generate the preview"} />
        <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
          {hasPreview
            ? "Push the saved brief and assets to a fresh build. The preview iframe above will refresh."
            : "Build the site and publish a shareable preview URL. Takes about a minute."}
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            onClick={handleDeploy}
            disabled={isDeployInFlight}
            style={{ ...btnStyle("var(--wp-gold)"), padding: "0.75rem 1.5rem", fontSize: "0.95rem" }}
          >
            {isDeployInFlight
              ? project.status === "provisioning"
                ? "Provisioning…"
                : project.status === "deploying"
                ? "Deploying…"
                : "Starting deploy…"
              : hasPreview
              ? "Re-deploy"
              : "Generate preview"}
          </button>
          <Link
            href={`/sites/${id}/edit`}
            style={{
              // Intentionally NOT using btnStyle("transparent") — that
              // helper picks text color based on the bg arg and falls
              // back to `var(--wp-dark)` for any non-card bg, which on
              // the dark theme renders invisible on the page background.
              // Explicit values here so the label stays legible.
              padding: "0.75rem 1.5rem",
              fontSize: "0.95rem",
              fontWeight: 600,
              background: "transparent",
              color: "var(--wp-text, #e6e6e6)",
              border: "1px solid var(--wp-border, rgba(255,255,255,0.2))",
              borderRadius: "6px",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              cursor: "pointer",
            }}
            onClick={() => {
              // Analytics: which doorway — guided flow vs prompt editor?
              // fetchWithRefresh rotates the JWT on 401 instead of
              // silently dropping the event. Fire-and-forget; UX must
              // not block on analytics.
              fetchWithRefresh("/api/analytics", {
                method: "POST",
                headers: jsonHeaders(),
                body: JSON.stringify({
                  event: "site.edit_entry_clicked",
                  metadata: {
                    project_id: id,
                    from: "detail_page",
                    page: window.location.pathname,
                  },
                }),
              }).catch(() => {});
            }}
          >
            Prompt editor →
          </Link>
        </div>
      </section>

      {/* Step 4 — Custom domain (only surfaces once the first deploy succeeded;
          before that, there's no Vercel project to bind a domain to). The
          DomainManager is self-contained: its own state, its own fetches via
          fetchWithRefresh, its own analytics. */}
      {hasPreview && (
        <section style={{ marginBottom: "2rem" }}>
          <SectionHeading step="4" title="Connect a custom domain (optional)" />
          <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
            Bind your client&apos;s domain (e.g. <code>acme.com</code>) so the site is shareable from a branded URL, not a preview link.
          </p>
          <DomainManager siteId={id} previewUrl={project.preview_url} />
        </section>
      )}

      {/* Inline status messages */}
      {error && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(220, 80, 80, 0.08)", border: "1px solid rgba(220, 80, 80, 0.4)", borderRadius: "6px", color: "#e07070", fontSize: "0.85rem", marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}
      {message && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(80, 200, 120, 0.08)", border: "1px solid rgba(80, 200, 120, 0.4)", borderRadius: "6px", color: "var(--wp-success, #6dcf85)", fontSize: "0.85rem" }}>
          {message}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ step, title }: { step: string; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.6rem",
          height: "1.6rem",
          borderRadius: "50%",
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          color: "var(--wp-gold)",
          fontWeight: 700,
          fontSize: "0.8rem",
        }}
      >
        {step}
      </span>
      <h2 style={{ fontSize: "1.05rem", margin: 0 }}>{title}</h2>
    </div>
  );
}

function btnStyle(bg = "var(--wp-card)"): React.CSSProperties {
  return {
    padding: "0.55rem 1rem",
    background: bg,
    color: bg === "var(--wp-card)" ? "var(--wp-text)" : "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "6px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.85rem",
  };
}
