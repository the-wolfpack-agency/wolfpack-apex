"use client";

/**
 * Self-serve enrollment for the autonomous watcher. A workspace enrolls a repo
 * here (or pauses / removes it) and the watcher picks it up on its next tick - no
 * env var, no redeploy. This is the SaaS onboarding surface: config is per-workspace
 * data managed in-app, so one deployment serves every client.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, SectionHeader, StatusPill } from "@/components/console";

interface WatchedRepo {
  repo: string;
  enabled: boolean;
  createdAt: string;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export default function WatchedReposPanel() {
  const [repos, setRepos] = useState<WatchedRepo[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/watched-repos");
      if (res.ok) setRepos(((await res.json()).repos ?? []) as WatchedRepo[]);
    } catch {
      /* leave list as-is -> empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enroll = async () => {
    const repo = input.trim();
    if (!REPO_RE.test(repo)) {
      setError("Enter a repository as owner/name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/watched-repos", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ repo }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not enroll the repository.");
        return;
      }
      setInput("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (repo: string, enabled: boolean) => {
    setBusy(true);
    try {
      await fetchWithRefresh("/api/admin/ai-code/watched-repos", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ repo, enabled }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (repo: string) => {
    setBusy(true);
    try {
      await fetchWithRefresh(`/api/admin/ai-code/watched-repos?repo=${encodeURIComponent(repo)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassPanel>
      <SectionHeader
        title="Watched repositories"
        subtitle="The factory watches these and drives their factory PRs to merge-ready. Never auto-merges; you approve."
      />

      <div style={{ display: "flex", gap: "0.5rem", margin: "0.75rem 0", flexWrap: "wrap" }}>
        <input
          aria-label="Repository (owner/name)"
          placeholder="owner/name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void enroll();
          }}
          disabled={busy}
          style={{ flex: "1 1 240px", minWidth: 0, padding: "0.5rem 0.6rem", borderRadius: 8, border: "1px solid var(--wp-border, #2a2f3a)", background: "var(--wp-bg-elev, #14171d)", color: "var(--wp-text, #e6e9ef)" }}
        />
        <button
          onClick={() => void enroll()}
          disabled={busy}
          style={{ padding: "0.5rem 0.9rem", borderRadius: 8, border: "1px solid var(--wp-border, #2a2f3a)", background: "var(--wp-accent, #3b82f6)", color: "#fff", cursor: busy ? "default" : "pointer" }}
        >
          Enroll
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.82rem", margin: "0 0 0.5rem" }}>
          {error}
        </p>
      )}

      {loading ? (
        <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>Loading…</p>
      ) : repos.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>
          No repositories enrolled yet. Add one above (as <code>owner/name</code>) and the watcher starts driving its
          factory PRs on the next tick.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
          {repos.map((r) => (
            <li key={r.repo} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--wp-mono, monospace)" }}>{r.repo}</span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <StatusPill status={r.enabled ? "active" : "paused"} tone={r.enabled ? "success" : "neutral"} label={r.enabled ? "Watching" : "Paused"} />
                <button onClick={() => void setEnabled(r.repo, !r.enabled)} disabled={busy} style={{ fontSize: "0.78rem", background: "none", border: "1px solid var(--wp-border, #2a2f3a)", color: "var(--wp-text, #e6e9ef)", borderRadius: 6, padding: "0.25rem 0.5rem", cursor: "pointer" }}>
                  {r.enabled ? "Pause" : "Resume"}
                </button>
                <button onClick={() => void remove(r.repo)} disabled={busy} style={{ fontSize: "0.78rem", background: "none", border: "1px solid var(--wp-border, #2a2f3a)", color: "var(--wp-error, #e5484d)", borderRadius: 6, padding: "0.25rem 0.5rem", cursor: "pointer" }}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}
