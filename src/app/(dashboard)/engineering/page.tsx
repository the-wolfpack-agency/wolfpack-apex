"use client";

/**
 * /engineering: the Engineering wiki.
 *
 * Reads /api/engineering (org-wide, engineering.view) and renders the
 * hierarchical wiki (sidebar tree + Markdown content) via EngineeringWiki.
 * Content is authored as rows (seed script / in-app editor), so the wiki grows
 * without a code change.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { WikiPage } from "@/lib/engineering-tree";
import EngineeringWiki from "@/components/engineering/EngineeringWiki";

export default function EngineeringPage() {
  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/engineering");
      if (!res.ok) {
        setError(`Could not load engineering pages (${res.status}).`);
        setPages([]);
        return;
      }
      const data = (await res.json()) as { pages?: WikiPage[] };
      setPages(Array.isArray(data.pages) ? data.pages : []);
    } catch {
      setError("Could not load engineering pages. Check your connection and try again.");
      setPages([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
      <header style={{ marginBottom: "1.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 800, color: "var(--wp-text, #e8eaed)" }}>
          Engineering
        </h1>
        <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.92rem" }}>
          How the Wolfpack systems are built: workflow, tools, compliance, testing, and what the agents can do.
        </p>
      </header>

      {error ? (
        <div
          data-testid="wiki-error"
          style={{
            border: "1px solid var(--wp-error, #ef4444)",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-text, #e8eaed)",
            borderRadius: 10,
            padding: "0.8rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          {error}{" "}
          <button
            type="button"
            onClick={() => void load()}
            style={{ all: "unset", cursor: "pointer", color: "var(--wp-gold, #e8b528)", fontWeight: 700 }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {pages === null ? (
        <div data-testid="wiki-loading" style={{ color: "var(--wp-text-dim, #9aa0aa)", padding: "2rem 0" }}>
          Loading engineering pages…
        </div>
      ) : (
        <EngineeringWiki pages={pages} />
      )}
    </div>
  );
}
