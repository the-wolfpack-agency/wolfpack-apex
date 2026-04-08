"use client";

/**
 * Site detail — guided brief editor + dropzones for files & assets +
 * embedded preview iframe.
 *
 * Three drop targets:
 *   1. Brief dropzone — drag an HTML/PDF/docx → calls /api/sites/parse-brief
 *      → replaces the current brief with the parsed result. The user
 *      reviews/edits in the form before saving.
 *   2. Asset dropzone — drag image files → calls /api/sites/[id]/assets
 *      → records the upload, commits to the client repo, returns a URL
 *      that gets surfaced as a copy-paste reference.
 *   3. Generate preview button → triggers a deploy.
 *
 * UI poll loop refreshes status every 4s while a deploy is in flight so
 * the iframe appears as soon as the webhook reports back.
 */

import { useEffect, useState, useRef, use } from "react";
import Link from "next/link";
import { BriefForm, type Brief } from "@/components/sites/BriefForm";

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: Brief;
  status: string;
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
  const token = typeof window !== "undefined" ? localStorage.getItem("apex_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<SiteProject | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadedAsset[]>([]);
  const briefDropRef = useRef<HTMLDivElement | null>(null);
  const assetDropRef = useRef<HTMLDivElement | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/sites/${id}`, { headers: authHeaders() });
    const data = await r.json();
    if (r.ok) {
      setProject(data.project);
      setBrief(data.project.brief as Brief);
    } else {
      setError(data.error ?? "failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (project && (project.status === "provisioning" || project.status === "deploying")) {
        load();
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
    const r = await fetch(`/api/sites/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ brief }),
    });
    const data = await r.json();
    if (!r.ok) setError(data.error ?? "save failed");
    else {
      setMessage("Saved.");
      setProject(data.project);
    }
    setSaving(false);
  }

  async function handleDeploy() {
    setDeploying(true);
    setError(null);
    setMessage(null);
    const r = await fetch(`/api/sites/${id}?action=deploy`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    const data = await r.json();
    if (!r.ok) setError(data.error ?? "deploy failed");
    else {
      setMessage("Deploy started — preview URL will appear when ready.");
      await load();
    }
    setDeploying(false);
  }

  async function handleParseFile(file: File) {
    if (!project) return;
    setParsing(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("clientSlug", project.client_slug);
    const r = await fetch("/api/sites/parse-brief", {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "parse failed");
    } else {
      setBrief(data.brief);
      setMessage(`Brief parsed (${data.source}, ${data.tokensUsed} tokens). Review and Save.`);
    }
    setParsing(false);
  }

  async function handleUploadAsset(file: File) {
    if (!project) return;
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/sites/${id}/assets`, {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "upload failed");
      return;
    }
    setUploads((u) => [...u, data.asset]);
    setMessage(`Uploaded ${data.asset.filename}${data.asset.committed ? " and committed to repo" : ""}.`);
  }

  function copyPreview() {
    if (project?.preview_url) {
      navigator.clipboard.writeText(project.preview_url);
      setMessage("Link copied.");
    }
  }

  if (loading) return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  if (!project || !brief) return <div style={{ padding: "2rem", color: "#c44" }}>{error ?? "Not found"}</div>;

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link href="/sites" style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}>
        ← All sites
      </Link>
      <h1 style={{ fontSize: "1.8rem", margin: "0.5rem 0" }}>{project.display_name}</h1>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", color: "var(--wp-text-dim)", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
        <span>{project.client_slug}</span>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--wp-gold)" }}>{project.status}</span>
        {project.github_repo_url && (
          <a href={project.github_repo_url} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold)" }}>
            GitHub ↗
          </a>
        )}
      </div>

      <Dropzone
        ref={briefDropRef}
        label={parsing ? "Parsing…" : "Drop a design brief (HTML / text / Markdown) to auto-fill this site"}
        accept=".html,.htm,.txt,.md"
        onFile={handleParseFile}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "1.25rem" }}>
        <div>
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Brief</h2>
          <BriefForm value={brief} onChange={setBrief} />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button onClick={handleSave} disabled={saving} style={btnStyle()}>
              {saving ? "Saving…" : "Save brief"}
            </button>
            <button onClick={handleDeploy} disabled={deploying} style={btnStyle("var(--wp-gold)")}>
              {deploying ? "Deploying…" : "Generate preview"}
            </button>
          </div>
          {error && <div style={{ color: "#c44", marginTop: "0.75rem", fontSize: "0.85rem" }}>{error}</div>}
          {message && <div style={{ color: "var(--wp-success)", marginTop: "0.75rem", fontSize: "0.85rem" }}>{message}</div>}

          <h3 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Assets</h3>
          <Dropzone
            ref={assetDropRef}
            label="Drop images here to upload to this site"
            accept="image/*"
            onFile={handleUploadAsset}
          />
          {uploads.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem", fontSize: "0.8rem" }}>
              {uploads.map((u) => (
                <li key={u.url} style={{ padding: "0.4rem 0", borderBottom: "1px solid var(--wp-border)" }}>
                  <code>{u.url}</code> {u.committed ? "✓ committed" : "(local only)"}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Preview</h2>
          {project.preview_url ? (
            <>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <a href={project.preview_url} target="_blank" rel="noreferrer" style={{ ...btnStyle("var(--wp-gold)"), display: "inline-block", textDecoration: "none", textAlign: "center" }}>
                  Open ↗
                </a>
                <button onClick={copyPreview} style={btnStyle()}>Copy link</button>
              </div>
              <iframe
                src={project.preview_url}
                style={{ width: "100%", height: "600px", border: "1px solid var(--wp-border)", borderRadius: "6px", background: "#fff" }}
                title={`${project.display_name} preview`}
              />
            </>
          ) : (
            <div style={{ padding: "2rem", border: "1px dashed var(--wp-border)", borderRadius: "6px", textAlign: "center", color: "var(--wp-text-dim)", minHeight: "600px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              No preview yet. Click <strong>Generate preview</strong> to deploy.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { forwardRef } from "react";
const Dropzone = forwardRef<HTMLDivElement, { label: string; accept: string; onFile: (f: File) => void }>(
  function Dropzone({ label, accept, onFile }, ref) {
    const [over, setOver] = useState(false);
    return (
      <div
        ref={ref}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        style={{
          padding: "1.25rem",
          border: `2px dashed ${over ? "var(--wp-gold)" : "var(--wp-border)"}`,
          borderRadius: "8px",
          textAlign: "center",
          background: over ? "rgba(255, 215, 0, 0.05)" : "transparent",
          transition: "all 0.15s ease",
          cursor: "pointer",
        }}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = accept;
          input.onchange = () => input.files?.[0] && onFile(input.files[0]);
          input.click();
        }}
      >
        <span style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>{label}</span>
      </div>
    );
  },
);

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
