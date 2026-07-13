"use client";

/**
 * AssigneePicker — directory-backed multi-select for assigning a task to one
 * or more individuals.
 *
 * Source of truth for "who can I assign to" is the cached tenant directory
 * (/api/directory/users, migration 027). Assignee ids are Microsoft Graph
 * user ids (DirectoryUser.msUserId), which is exactly what Planner's
 * `assignments` map keys on — so the selection produced here drops straight
 * into POST/PATCH /api/planner/tasks { assignees }.
 *
 * Microsoft To Do tasks have NO assignments in Graph; that is why picking an
 * assignee promotes a task to a shared Planner task. This component is the
 * shared control used by both the /tasks and /planner surfaces.
 *
 * All reads go through fetchWithRefresh (never raw fetch) per the client-auth
 * directive. Colors use var(--wp-*) theme tokens only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, fetchWithRefresh } from "@/lib/client-auth";

export interface AssigneeOption {
  id: string; // Graph user id (msUserId)
  name: string;
  email?: string | null;
  jobTitle?: string | null;
}

interface DirectoryUserResponse {
  msUserId: string;
  displayName: string | null;
  userPrincipalName: string | null;
  mail: string | null;
  jobTitle: string | null;
}

interface AssigneePickerProps {
  /** Selected Graph user ids. */
  value: string[];
  /** Fires with the new id list + the options for those ids (so a parent can
   *  map ids → names for display). */
  onChange: (ids: string[], options: AssigneeOption[]) => void;
  /** Which surface is using the picker — drives analytics context. */
  context: "tasks" | "planner";
  /** Pre-known names for already-selected ids (e.g. resolved from the task). */
  knownById?: Record<string, AssigneeOption>;
  /** Optional label rendered above the control. */
  label?: string;
}

function fireAnalytics(event: "tasks.assignee_searched" | "tasks.task_assigned", metadata: Record<string, string | number>) {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

export default function AssigneePicker({ value, onChange, context, knownById, label = "Assign to" }: AssigneePickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssigneeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  // Registry of id → option so selected chips always render a name even after
  // the results list changes.
  const [registry, setRegistry] = useState<Record<string, AssigneeOption>>(() => ({ ...(knownById ?? {}) }));

  useEffect(() => {
    if (knownById) setRegistry((prev) => ({ ...knownById, ...prev }));
  }, [knownById]);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "8" });
      if (q.trim()) params.set("search", q.trim());
      const res = await fetchWithRefresh(`/api/directory/users?${params}`, { headers: authHeaders() });
      if (!res.ok) { setResults([]); setSearched(true); return; }
      const data = await res.json();
      const opts: AssigneeOption[] = (data.users || []).map((u: DirectoryUserResponse) => ({
        id: u.msUserId,
        name: u.displayName || u.userPrincipalName || u.mail || "Unknown",
        email: u.mail || u.userPrincipalName,
        jobTitle: u.jobTitle,
      }));
      setResults(opts);
      setRegistry((prev) => {
        const next = { ...prev };
        for (const o of opts) next[o.id] = o;
        return next;
      });
      setSearched(true);
      fireAnalytics("tasks.assignee_searched", { context, query_len: q.trim().length });
    } finally {
      setLoading(false);
    }
  }, [context]);

  // Debounced search on query change.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { runSearch(query); }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const selectedOptions = useMemo<AssigneeOption[]>(
    () => value.map((id) => registry[id] ?? { id, name: id }),
    [value, registry],
  );

  function toggle(opt: AssigneeOption) {
    setRegistry((prev) => ({ ...prev, [opt.id]: opt }));
    const isSelected = value.includes(opt.id);
    const nextIds = isSelected ? value.filter((v) => v !== opt.id) : [...value, opt.id];
    const nextOpts = nextIds.map((id) => (id === opt.id ? opt : registry[id] ?? { id, name: id }));
    onChange(nextIds, nextOpts);
  }

  function remove(id: string) {
    const nextIds = value.filter((v) => v !== id);
    onChange(nextIds, nextIds.map((i) => registry[i] ?? { id: i, name: i }));
  }

  const available = results.filter((o) => !value.includes(o.id));

  return (
    <div data-testid="assignee-picker">
      <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>{label}</label>

      {selectedOptions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-2" aria-label="Selected assignees">
          {selectedOptions.map((o) => (
            <li
              key={o.id}
              data-testid="assignee-chip"
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              {o.name}
              <button
                type="button"
                aria-label={`Remove ${o.name}`}
                onClick={() => remove(o.id)}
                className="leading-none"
                style={{ color: "var(--wp-dark)" }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search teammates by name…"
        aria-label="Search teammates to assign"
        data-testid="assignee-search"
        className="w-full px-3 py-2 rounded-md text-sm border"
        style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
      />

      {loading && (
        <div className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>Searching…</div>
      )}

      {!loading && searched && available.length === 0 && (
        <div data-testid="assignee-empty" className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>
          {results.length === 0
            ? "No teammates found. Sync your directory in Settings, then try again."
            : "Everyone matching is already assigned."}
        </div>
      )}

      {available.length > 0 && (
        <ul className="mt-1 border rounded-md overflow-hidden" role="listbox" aria-label="Teammate results"
          style={{ borderColor: "var(--wp-dark-border)" }}>
          {available.map((o) => (
            <li key={o.id} role="option" aria-selected={false}>
              <button
                type="button"
                data-testid="assignee-option"
                onClick={() => toggle(o)}
                className="w-full text-left px-3 py-2 text-sm wp-hover-lift"
                style={{ background: "var(--wp-dark-surface)" }}
              >
                <span className="font-medium">{o.name}</span>
                {o.jobTitle && (
                  <span className="ml-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{o.jobTitle}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
