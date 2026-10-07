"use client";

/**
 * Forcefield docs - the GTM / launch doc set, in the app (not repo-only markdown).
 *
 * The team reads pricing, licensing, SLA, security, subprocessors, and the legal
 * DRAFT templates here. Admin-gated (settings.manage_team on the API). A sidebar
 * lists the docs by category; the pane renders the selected doc. The docs are
 * internal DRAFT - a banner says so.
 *
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, SectionHeader } from "@/components/console";

interface DocMeta { key: string; title: string; category: string; file: string }

export default function ForcefieldDocsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [active, setActive] = useState<string>("readme");
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) { router.push("/login?next=/admin/forcefield/docs"); return; }
    setReady(true);
  }, [router]);

  const open = useCallback(async (key: string) => {
    setActive(key); setLoading(true);
    try {
      const res = await fetchWithRefresh(`/api/admin/forcefield/docs?doc=${encodeURIComponent(key)}`);
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setHtml(body.html as string);
        if (Array.isArray(body.docs)) setDocs(body.docs as DocMeta[]);
      } else {
        setHtml("<p>This document is unavailable.</p>");
      }
    } catch {
      setHtml("<p>Could not load this document.</p>");
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (ready) void open(active); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return null;

  const categories = Array.from(new Set(docs.map((d) => d.category)));

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield-docs">
      <SectionHeader title="Forcefield docs" subtitle="Pricing, licensing, SLA, security, and the legal templates. Internal draft, do not publish." />

      <div style={{ marginTop: "1.25rem", display: "grid", gridTemplateColumns: "240px 1fr", gap: "1.25rem", alignItems: "start" }}>
        <nav data-testid="ff-docs-nav" style={{ display: "flex", flexDirection: "column", gap: ".9rem", position: "sticky", top: "1rem" }}>
          {categories.map((cat) => (
            <div key={cat}>
              <div style={{ fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--wp-text-dim)", marginBottom: ".35rem" }}>{cat}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {docs.filter((d) => d.category === cat).map((d) => (
                  <button
                    key={d.key}
                    data-testid={`ff-doc-${d.key}`}
                    onClick={() => void open(d.key)}
                    style={{
                      textAlign: "left", padding: ".35rem .5rem", borderRadius: 6, fontSize: ".85rem",
                      background: active === d.key ? "rgba(232,181,40,0.12)" : "transparent",
                      color: active === d.key ? "var(--wp-gold)" : "var(--wp-text)",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    {d.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <GlassPanel padded>
          {loading ? (
            <p data-testid="ff-docs-loading" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
          ) : (
            <article
              data-testid="ff-docs-body"
              className="prose prose-invert max-w-none [&_table]:border-collapse [&_table]:w-full [&_h1]:text-2xl [&_h2]:text-xl [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:mt-4 [&_a]:text-[color:var(--wp-gold)] [&_a]:underline [&_td]:border [&_td]:border-white/10 [&_td]:px-2 [&_td]:py-1 [&_code]:text-[13px] [&_pre]:overflow-x-auto"
              style={{ color: "var(--wp-text)" }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </GlassPanel>
      </div>
    </div>
  );
}
