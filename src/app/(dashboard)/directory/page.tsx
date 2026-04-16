"use client";

/**
 * /directory — tenant user search page.
 *
 * Reads from the cache. "Refresh directory" calls POST /api/directory/sync
 * which is rate-limited to 1/15min.
 */

import { useEffect, useState, useCallback } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import UserCard, { type DirectoryUserView } from "@/components/directory/UserCard";

interface ListResponse {
  users: DirectoryUserView[];
  nextCursor: string | null;
}

export default function DirectoryPage() {
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [users, setUsers] = useState<DirectoryUserView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const qp = new URLSearchParams();
      if (search) qp.set("search", search);
      if (department) qp.set("department", department);
      if (cursor) qp.set("cursor", cursor);
      try {
        const res = await fetchWithRefresh(`/api/directory/users?${qp.toString()}`, {
          headers: authHeaders(),
        });
        if (!res.ok) {
          setError("Directory unavailable");
          return;
        }
        const body = (await res.json()) as ListResponse;
        setUsers((prev) => (append ? [...prev, ...body.users] : body.users));
        setNextCursor(body.nextCursor);
      } catch {
        setError("Directory unavailable");
      } finally {
        setLoading(false);
      }
    },
    [search, department],
  );

  useEffect(() => {
    fetchPage(null, false);
  }, [fetchPage]);

  async function onSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/directory/sync", {
        method: "POST",
        headers: jsonHeaders(),
      });
      if (res.status === 429) {
        setError("Directory sync already ran recently — try again later");
        return;
      }
      if (res.status === 403) {
        setError("Missing scope — reconnect Microsoft with User.Read.All");
        return;
      }
      if (!res.ok) {
        setError("Sync failed");
        return;
      }
      await fetchPage(null, false);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Directory
          </h1>
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            All people in your Microsoft 365 tenant.
          </p>
        </div>
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="text-sm px-3 py-1.5 rounded border"
          style={{
            borderColor: "var(--wp-dark-border)",
            color: syncing ? "var(--wp-text-dim)" : "var(--wp-gold)",
          }}
          data-testid="directory-sync-btn"
        >
          {syncing ? "Syncing…" : "Refresh directory"}
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder="Search by name, title, department…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 rounded border text-sm"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
          data-testid="directory-search-input"
        />
        <input
          type="text"
          placeholder="Department (exact)"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="md:w-64 px-3 py-2 rounded border text-sm"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
          data-testid="directory-department-input"
        />
      </div>

      {error ? (
        <div
          className="mb-4 text-sm px-3 py-2 rounded"
          style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}
          data-testid="directory-error"
        >
          {error}
        </div>
      ) : null}

      <div
        className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        data-testid="directory-grid"
      >
        {users.map((u) => (
          <UserCard key={u.id} user={u} showManager showDirectReports />
        ))}
        {users.length === 0 && !loading ? (
          <p
            className="col-span-full text-sm"
            style={{ color: "var(--wp-text-dim)" }}
            data-testid="directory-empty"
          >
            No users match the filters. Try refreshing the directory.
          </p>
        ) : null}
      </div>

      {nextCursor ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => fetchPage(nextCursor, true)}
            disabled={loading}
            className="text-sm px-3 py-1.5 rounded border"
            style={{
              borderColor: "var(--wp-dark-border)",
              color: "var(--wp-text-dim)",
            }}
            data-testid="directory-load-more"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
