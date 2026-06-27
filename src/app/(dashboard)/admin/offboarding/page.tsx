"use client";

/**
 * /admin/offboarding - DESTRUCTIVE client-offboarding console.
 *
 * When a client offboards we must purge ALL of their platform-scan data across
 * Postgres + Qdrant + Neo4j (findings, scans, targets, ownership verifications,
 * system profiles, automation recommendations, pentest authorizations, and
 * connector credentials) and keep an auditable record. There is otherwise no
 * clean way to remove a client - a contractual / GDPR retention failure.
 *
 * This is irreversible, so the action is strongly guarded: the operator must
 * TYPE the exact workspace id into the confirmation field; the purge button stays
 * disabled until it matches. The server independently re-checks the same
 * confirmation (defense in depth) and gates on settings.manage_team.
 *
 * Auth: redirects unauthenticated users to /login (no blank state). Every fetch
 * goes through fetchWithRefresh (15-min access TTL, HttpOnly refresh rotation).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface UserInfo {
  role: string;
}

// Mirrors OffboardResult from src/lib/platform-scan/offboarding.ts.
interface OffboardResult {
  ok: boolean;
  workspaceId: string;
  counts: Record<string, number>;
  residue: Record<string, string>;
  totalDeleted: number;
  secondaryStoresClean: boolean;
}

// The tables this purge clears, in a human-readable order, so the operator sees
// exactly WHAT will be erased before they confirm. Keys match the server counts.
const PURGED_TABLES: { key: string; label: string }[] = [
  { key: "instinct_platform_scan_findings", label: "Scan findings" },
  { key: "instinct_platform_scans", label: "Scan runs + coverage" },
  { key: "instinct_scan_targets", label: "Onboarded scan targets" },
  { key: "instinct_target_verifications", label: "Ownership verifications" },
  { key: "instinct_system_profiles", label: "System profiles" },
  { key: "instinct_automation_recommendations", label: "Automation recommendations" },
  { key: "instinct_pentest_authorizations", label: "Pentest authorizations" },
  { key: "instinct_connector_credentials", label: "Connector credentials" },
];

const card = {
  padding: "1rem 1.1rem",
  background: "var(--wp-dark-surface, #1f1f22)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: "0.5rem",
} as const;

export default function OffboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OffboardResult | null>(null);

  useEffect(() => {
    const u = getInstinctUser<UserInfo>();
    if (!u) {
      router.push("/login?next=/admin/offboarding");
      return;
    }
    setUser(u);
  }, [router]);

  // The purge is enabled ONLY when the operator has typed the exact workspace id
  // into the confirmation field. Empty workspace id never enables it.
  const wsTrimmed = workspaceId.trim();
  const confirmMatches = wsTrimmed.length > 0 && confirmText.trim() === wsTrimmed;

  const runPurge = useCallback(async () => {
    if (!confirmMatches) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/offboard", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ workspaceId: wsTrimmed, confirm: confirmText.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(body.detail ?? body.error ?? `Offboarding failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as OffboardResult;
      setResult(data);
      // Reset the confirmation so a second click can't re-fire by accident.
      setConfirmText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [confirmMatches, wsTrimmed, confirmText]);

  if (!user) {
    // Redirect is in flight; render nothing rather than a blank authed shell.
    return null;
  }

  return (
    <div
      data-testid="offboarding-page"
      style={{ padding: "1.5rem", maxWidth: 760, margin: "0 auto", color: "var(--wp-text, #eee)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Client offboarding</h1>
        <span style={{ flex: 1 }} />
        <Link href="/admin/platform-scans" data-testid="back-to-scans" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
          ← Platform scans
        </Link>
      </div>
      <p style={{ marginTop: 0, marginBottom: "1.2rem", fontSize: "0.9rem", color: "var(--wp-text-muted, #6b7280)" }}>
        Permanently erase every trace of a client&apos;s platform-scan data across all stores. This is
        irreversible and produces an auditable record of exactly what was purged.
      </p>

      <div
        data-testid="offboard-warning"
        role="alert"
        style={{
          ...card,
          marginBottom: "1.2rem",
          background: "rgba(239, 68, 68, 0.12)",
          border: "1px solid var(--wp-error, #ef4444)",
        }}
      >
        <strong style={{ color: "var(--wp-error, #ef4444)" }}>Destructive and irreversible.</strong>{" "}
        This deletes the following for the workspace and cannot be undone:
        <ul data-testid="purge-table-list" style={{ margin: "0.6rem 0 0", paddingLeft: "1.2rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
          {PURGED_TABLES.map((t) => (
            <li key={t.key} data-testid={`purge-table-${t.key}`}>{t.label}</li>
          ))}
        </ul>
      </div>

      <div style={{ ...card, marginBottom: "1.2rem" }}>
        <label htmlFor="workspace-id" style={{ display: "block", fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", marginBottom: "0.3rem" }}>
          Workspace id to offboard
        </label>
        <input
          id="workspace-id"
          data-testid="workspace-id-input"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          placeholder="e.g. acme-crm"
          autoComplete="off"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.5rem 0.7rem",
            marginBottom: "0.9rem",
            borderRadius: "0.4rem",
            fontSize: "0.9rem",
            color: "var(--wp-text, #eee)",
            background: "var(--wp-dark-bg, #141416)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        />

        <label htmlFor="confirm-text" style={{ display: "block", fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", marginBottom: "0.3rem" }}>
          Type the workspace id again to confirm
        </label>
        <input
          id="confirm-text"
          data-testid="confirm-input"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Re-type the exact workspace id"
          autoComplete="off"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.5rem 0.7rem",
            marginBottom: "0.9rem",
            borderRadius: "0.4rem",
            fontSize: "0.9rem",
            color: "var(--wp-text, #eee)",
            background: "var(--wp-dark-bg, #141416)",
            border: `1px solid ${
              confirmText.length > 0 && !confirmMatches ? "var(--wp-error, #ef4444)" : "var(--wp-dark-border, #333)"
            }`,
          }}
        />
        {confirmText.length > 0 && !confirmMatches && (
          <div data-testid="confirm-mismatch" style={{ fontSize: "0.8rem", color: "var(--wp-error, #ef4444)", marginBottom: "0.6rem" }}>
            Confirmation does not match the workspace id.
          </div>
        )}

        <button
          type="button"
          data-testid="purge-button"
          disabled={!confirmMatches || busy}
          onClick={() => void runPurge()}
          style={{
            padding: "0.55rem 1.1rem",
            borderRadius: "0.4rem",
            border: "none",
            fontWeight: 700,
            color: "#fff",
            background: "var(--wp-error, #ef4444)",
            cursor: !confirmMatches || busy ? "default" : "pointer",
            opacity: !confirmMatches || busy ? 0.5 : 1,
          }}
        >
          {busy ? "Purging…" : "Permanently offboard workspace"}
        </button>
      </div>

      {error && (
        <div data-testid="offboard-error" role="alert" style={{ ...card, marginBottom: "1.2rem", color: "var(--wp-error, #ef4444)", border: "1px solid var(--wp-error, #ef4444)" }}>
          {error}
        </div>
      )}

      {result && (
        <div data-testid="offboard-result" style={{ ...card }}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem", color: "var(--wp-gold, #f1c233)" }}>
            Offboarded {result.workspaceId}
          </h2>
          <p data-testid="result-total" style={{ margin: "0 0 0.8rem", fontSize: "0.9rem", color: "var(--wp-text, #eee)" }}>
            {result.totalDeleted} row{result.totalDeleted === 1 ? "" : "s"} purged from Postgres.
          </p>
          <div data-testid="result-counts" style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "0.8rem" }}>
            {PURGED_TABLES.map((t) => (
              <div
                key={t.key}
                data-testid={`result-count-${t.key}`}
                style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
              >
                <span>{t.label}</span>
                <span style={{ fontWeight: 600, color: "var(--wp-text, #eee)" }}>{result.counts?.[t.key] ?? 0}</span>
              </div>
            ))}
          </div>
          {result.secondaryStoresClean ? (
            <div data-testid="result-residue-clean" style={{ fontSize: "0.85rem", color: "var(--wp-success, #22c55e)" }}>
              Qdrant + Neo4j purged cleanly.
            </div>
          ) : (
            <div data-testid="result-residue" role="alert" style={{ fontSize: "0.85rem", color: "var(--wp-error, #ef4444)" }}>
              Secondary-store residue (queued for retry):{" "}
              {Object.entries(result.residue)
                .map(([store, reason]) => `${store} (${reason})`)
                .join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
