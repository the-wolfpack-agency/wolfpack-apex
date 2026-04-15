"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, authHeaders } from "@/lib/client-auth";

interface AuditEntry {
  id: string;
  seq: number;
  ts: string;
  actor: { user_id: string; role: string };
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  entryHash: string;
}

interface QueryPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

interface VerifyResult {
  valid: boolean;
  brokenAt?: number;
  checkedCount: number;
  reason?: string;
}

interface UserInfo {
  role: string;
}

function isAdmin(user: UserInfo | null): boolean {
  return !!user && (user.role === "ceo" || user.role === "cto");
}

function ValueBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span style={{ color: "var(--wp-text-dim)" }}>(none)</span>;
  }
  return (
    <pre
      className="text-xs overflow-auto rounded p-2"
      style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)", maxHeight: 240 }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function AuditLogPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Filters
  const [actorFilter, setActorFilter] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState("");
  const [sinceFilter, setSinceFilter] = useState("");
  const [untilFilter, setUntilFilter] = useState("");

  useEffect(() => {
    const u = getInstinctUser<UserInfo>();
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);
    if (!isAdmin(u)) {
      setLoading(false);
      setError("This page is for CEO/CTO roles only.");
    }
  }, [router]);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (actorFilter) params.set("actor_user_id", actorFilter);
      if (resourceTypeFilter) params.set("resource_type", resourceTypeFilter);
      if (sinceFilter) params.set("since", sinceFilter);
      if (untilFilter) params.set("until", untilFilter);
      if (cursor) params.set("cursor", cursor);
      try {
        const res = await fetch(`/api/admin/audit-log?${params.toString()}`, {
          headers: authHeaders(),
        });
        if (!res.ok) {
          setError(`Error ${res.status}`);
          setLoading(false);
          return;
        }
        const data: QueryPage = await res.json();
        if (cursor) {
          setEntries((prev) => [...prev, ...data.entries]);
        } else {
          setEntries(data.entries);
        }
        setNextCursor(data.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [actorFilter, resourceTypeFilter, sinceFilter, untilFilter],
  );

  useEffect(() => {
    if (user && isAdmin(user)) void load();
  }, [user, load]);

  async function onVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/admin/audit-log/verify", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      const data: VerifyResult = await res.json();
      setVerifyResult(data);
    } catch (e) {
      setVerifyResult({ valid: false, checkedCount: 0, reason: (e as Error).message });
    } finally {
      setVerifying(false);
    }
  }

  async function onExport() {
    const res = await fetch("/api/admin/audit-log/export", { headers: authHeaders() });
    if (!res.ok) {
      setError(`Export failed: ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `instinct-audit-log-${new Date().toISOString().slice(0, 10)}.ndjson`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (!user) return null;
  if (!isAdmin(user)) {
    return (
      <div className="p-6 text-sm" style={{ color: "var(--wp-text-dim)" }}>
        {error ?? "Admin access required."}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold" style={{ color: "var(--wp-gold)" }}>
          Audit Log
        </h1>
        <div className="flex gap-2">
          <button
            onClick={onVerify}
            disabled={verifying}
            className="px-3 py-2 rounded text-sm"
            style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
          >
            {verifying ? "Verifying…" : "Verify integrity"}
          </button>
          <button
            onClick={onExport}
            className="px-3 py-2 rounded text-sm"
            style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
          >
            Export NDJSON
          </button>
        </div>
      </div>

      {verifyResult && (
        <div
          className="mb-4 rounded p-3 text-sm"
          style={{
            background: verifyResult.valid ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${verifyResult.valid ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.6)"}`,
            color: verifyResult.valid ? "#22c55e" : "#ef4444",
          }}
        >
          {verifyResult.valid
            ? `Chain valid — verified ${verifyResult.checkedCount} entries.`
            : `Tamper suspected at seq ${verifyResult.brokenAt ?? "?"} (${verifyResult.reason ?? "unknown"}).`}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-4">
        <input
          placeholder="Actor user id"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          className="px-2 py-1 rounded text-sm"
          style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
        />
        <input
          placeholder="Resource type"
          value={resourceTypeFilter}
          onChange={(e) => setResourceTypeFilter(e.target.value)}
          className="px-2 py-1 rounded text-sm"
          style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
        />
        <input
          type="datetime-local"
          value={sinceFilter}
          onChange={(e) => setSinceFilter(e.target.value)}
          className="px-2 py-1 rounded text-sm"
          style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
        />
        <input
          type="datetime-local"
          value={untilFilter}
          onChange={(e) => setUntilFilter(e.target.value)}
          className="px-2 py-1 rounded text-sm"
          style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
        />
      </div>

      <button
        onClick={() => load()}
        className="px-3 py-1.5 rounded text-sm mb-4"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark-base)" }}
      >
        Apply filters
      </button>

      {error && (
        <div className="mb-3 text-sm" style={{ color: "#ef4444" }}>
          {error}
        </div>
      )}

      <div
        className="rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--wp-dark-border)" }}
      >
        <table className="w-full text-xs">
          <thead style={{ background: "var(--wp-dark-elevated)" }}>
            <tr>
              <th className="text-left px-2 py-1.5">Seq</th>
              <th className="text-left px-2 py-1.5">When</th>
              <th className="text-left px-2 py-1.5">Actor</th>
              <th className="text-left px-2 py-1.5">Action</th>
              <th className="text-left px-2 py-1.5">Resource</th>
              <th className="text-left px-2 py-1.5">IP</th>
              <th className="text-left px-2 py-1.5">Req ID</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const expanded = expandedId === e.id;
              return (
                <Fragment key={e.id}>
                  <tr
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                    className="cursor-pointer"
                    style={{ borderTop: "1px solid var(--wp-dark-border)" }}
                  >
                    <td className="px-2 py-1.5">{e.seq}</td>
                    <td className="px-2 py-1.5">{new Date(e.ts).toLocaleString()}</td>
                    <td className="px-2 py-1.5">
                      {e.actor.user_id} <span style={{ color: "var(--wp-text-dim)" }}>({e.actor.role})</span>
                    </td>
                    <td className="px-2 py-1.5">{e.action}</td>
                    <td className="px-2 py-1.5">
                      {e.resourceType}
                      {e.resourceId ? `:${e.resourceId.slice(0, 10)}` : ""}
                    </td>
                    <td className="px-2 py-1.5">{e.ipAddress ?? "—"}</td>
                    <td className="px-2 py-1.5">{e.requestId ? e.requestId.slice(0, 10) : "—"}</td>
                  </tr>
                  {expanded && (
                    <tr style={{ borderTop: "1px solid var(--wp-dark-border)" }}>
                      <td colSpan={7} className="px-2 py-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <div className="text-xs font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
                              Before
                            </div>
                            <ValueBlock value={e.beforeState} />
                          </div>
                          <div>
                            <div className="text-xs font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
                              After
                            </div>
                            <ValueBlock value={e.afterState} />
                          </div>
                        </div>
                        <div className="mt-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>
                          entry_hash: <code>{e.entryHash.slice(0, 32)}…</code>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {entries.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center" style={{ color: "var(--wp-text-dim)" }}>
                  No entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <button
          onClick={() => load(nextCursor)}
          disabled={loading}
          className="mt-3 px-3 py-1.5 rounded text-sm"
          style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
