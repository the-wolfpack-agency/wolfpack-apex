"use client";

/**
 * /releases — the "What's new" changelog wiki.
 *
 * Reads /api/releases (org-wide, releases.view) and renders a date-organized
 * timeline: year tabs + month groups + expandable feature breakdowns. Populated
 * by the release-notes generator (scripts/generate-release-notes.mjs) or the
 * manual publish path.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { Release } from "@/lib/releases";
import ReleaseTimeline from "@/components/releases/ReleaseTimeline";

export default function ReleasesPage() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/releases");
      if (!res.ok) {
        setError(`Could not load releases (${res.status}).`);
        setReleases([]);
        return;
      }
      const data = (await res.json()) as { releases?: Release[] };
      setReleases(Array.isArray(data.releases) ? data.releases : []);
    } catch {
      setError("Could not load releases. Check your connection and try again.");
      setReleases([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
      <header style={{ marginBottom: "1.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 800, color: "var(--wp-text, #e8eaed)" }}>
          What&apos;s new
        </h1>
        <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.95rem" }}>
          Every release, newest first, with what changed and how to use it. Use
          the year tabs to jump by date.
        </p>
      </header>

      {error ? (
        <div
          data-testid="releases-error"
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

      {releases === null ? (
        <div data-testid="releases-loading" style={{ color: "var(--wp-text-dim, #9aa0aa)", padding: "2rem 0" }}>
          Loading releases…
        </div>
      ) : (
        <ReleaseTimeline releases={releases} />
      )}
    </div>
  );
}
