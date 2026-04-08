"use client";

/**
 * Sites — list + create new client sites.
 *
 * The Max + Meghan landing page. Shows every project with status pills,
 * and a "+ New Site" form that takes the bare minimum (slug, display
 * name, support email) and pre-fills a starter brief. Once created, the
 * detail page is where the brief gets fleshed out and deployed.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  status: "draft" | "provisioning" | "deploying" | "ready" | "failed";
  preview_url: string | null;
  github_repo_url: string | null;
  last_canary_passed: boolean | null;
  updated_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "var(--wp-text-dim)",
  provisioning: "var(--wp-info)",
  deploying: "var(--wp-warning)",
  ready: "var(--wp-success)",
  failed: "var(--wp-error, #c44)",
};

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("apex_token") : null;
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export default function SitesPage() {
  const [projects, setProjects] = useState<SiteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tagline, setTagline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const router = useRouter();

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/sites", { headers: authHeaders() });
      const data = await r.json();
      setProjects(data.projects ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[a-z][a-z0-9-]{1,38}$/.test(slug)) {
      setError("Slug must be lowercase letters, numbers, or dashes (e.g. cftr, acme-co)");
      return;
    }
    const brief = {
      client: slug,
      product: { name, tagline, supportEmail: email },
      pages: [
        {
          route: "/",
          title: "Home",
          sections: [
            { type: "hero", heading: name, body: tagline, cta: { label: "Get in touch", href: "/contact" } },
            { type: "callout", body: "Edit this brief in Instinct → Sites to populate the rest." },
          ],
        },
      ],
      contactForm: { fields: ["name", "email", "message"] },
    };
    const r = await fetch("/api/sites", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ brief }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "failed to create");
      return;
    }
    setShowForm(false);
    setSlug("");
    setName("");
    setEmail("");
    setTagline("");
    await load();
  }

  async function handleDropFile(file: File) {
    if (!slug || !/^[a-z][a-z0-9-]{1,38}$/.test(slug)) {
      setError("Enter a slug first (lowercase letters/numbers/dashes), then drop the brief.");
      setShowForm(true);
      return;
    }
    setParsing(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("clientSlug", slug);
    const r = await fetch("/api/sites/parse-brief", {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "parse failed");
      setParsing(false);
      return;
    }
    // Create the project with the parsed brief, then jump to detail page.
    const create = await fetch("/api/sites", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ brief: data.brief }),
    });
    const created = await create.json();
    setParsing(false);
    if (!create.ok) {
      setError(created.error ?? "create failed");
      return;
    }
    router.push(`/sites/${created.project.id}`);
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Sites</h1>
          <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
            Spin up a hosted client site in under a minute. No terminal, no GitHub.
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          style={{
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            border: "none",
            padding: "0.6rem 1.2rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {showForm ? "Cancel" : "+ New Site"}
        </button>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) handleDropFile(f);
        }}
        onClick={() => {
          const i = document.createElement("input");
          i.type = "file";
          i.accept = ".html,.htm,.txt,.md";
          i.onchange = () => i.files?.[0] && handleDropFile(i.files[0]);
          i.click();
        }}
        style={{
          padding: "1.5rem",
          border: "2px dashed var(--wp-border)",
          borderRadius: "8px",
          textAlign: "center",
          marginBottom: "1rem",
          cursor: "pointer",
          color: "var(--wp-text-dim)",
          fontSize: "0.85rem",
        }}
      >
        {parsing
          ? "Parsing brief…"
          : "Drop a design brief here (HTML / text / Markdown) — we'll auto-fill the site. (Set a slug below first.)"}
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "8px",
            padding: "1.5rem",
            marginBottom: "2rem",
            display: "grid",
            gap: "1rem",
          }}
        >
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "0.3rem" }}>Slug (lowercase, becomes wolfpack-{"{slug}"} repo)</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="cftr" required style={inputStyle} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "0.3rem" }}>Display name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cleared for Takeoff Racing" required style={inputStyle} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "0.3rem" }}>Tagline</label>
            <input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Irish racing on the world's biggest stage" style={inputStyle} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "0.3rem" }}>Support email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello@aidanmulready.com" style={inputStyle} />
          </div>
          {error && <div style={{ color: "#c44", fontSize: "0.85rem" }}>{error}</div>}
          <button type="submit" style={{ background: "var(--wp-gold)", color: "var(--wp-dark)", border: "none", padding: "0.6rem", borderRadius: "6px", fontWeight: 600, cursor: "pointer" }}>
            Create draft
          </button>
        </form>
      )}

      {loading ? (
        <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>
      ) : projects.length === 0 ? (
        <div style={{ padding: "3rem", textAlign: "center", border: "1px dashed var(--wp-border)", borderRadius: "8px", color: "var(--wp-text-dim)" }}>
          No sites yet. Click <strong>+ New Site</strong> to create the first one.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/sites/${p.id}`}
              style={{
                display: "block",
                padding: "1rem 1.25rem",
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                borderRadius: "8px",
                textDecoration: "none",
                color: "var(--wp-text)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.display_name}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)", marginTop: "0.2rem" }}>
                    {p.client_slug} · updated {new Date(p.updated_at).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em", color: STATUS_COLORS[p.status], fontWeight: 600 }}>{p.status}</span>
                  {p.preview_url && (
                    <a href={p.preview_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: "0.75rem", color: "var(--wp-gold)" }}>
                      Preview ↗
                    </a>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.8rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "6px",
  color: "var(--wp-text)",
  fontSize: "0.95rem",
};
