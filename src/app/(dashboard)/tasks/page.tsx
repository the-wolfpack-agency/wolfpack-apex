"use client";

/**
 * Tasks — Microsoft To Do integration.
 *
 * Reads come from /api/tasks (local cache). Writes go through the API,
 * which write-throughs to Graph. Poll every 60s + refetch after sync.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

type TaskStatus = "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";
type TaskImportance = "low" | "normal" | "high";

interface TaskList {
  id: string;
  msListId: string;
  displayName: string;
}

interface Task {
  id: string;
  msTaskId: string;
  listId: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  importance: TaskImportance;
  dueAt: string | null;
  completedAt: string | null;
}

const STATUS_TABS: { id: "open" | "inProgress" | "completed"; label: string; match: TaskStatus[] }[] = [
  { id: "open", label: "Open", match: ["notStarted", "waitingOnOthers", "deferred"] },
  { id: "inProgress", label: "In Progress", match: ["inProgress"] },
  { id: "completed", label: "Completed", match: ["completed"] },
];

function fmtDue(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return ""; }
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [listFilter, setListFilter] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"open" | "inProgress" | "completed">("open");
  const [syncing, setSyncing] = useState(false);
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadTasks = useCallback(async () => {
    const params = new URLSearchParams();
    if (listFilter) params.set("listId", listFilter);
    if (search) params.set("search", search);
    const res = await fetchWithRefresh(`/api/tasks${params.toString() ? "?" + params : ""}`, {
      headers: authHeaders(),
    });
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) return;
    const data = await res.json();
    setTasks(data.tasks || []);
  }, [search, listFilter]);

  const loadLists = useCallback(async () => {
    const res = await fetchWithRefresh("/api/tasks/lists", { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    setLists(data.lists || []);
  }, []);

  const loadMsStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/integrations/status", { headers: authHeaders() });
      if (!res.ok) { setMsConnected(false); return; }
      const data = await res.json();
      setMsConnected(!!(data?.microsoft?.connected ?? data?.microsoft));
    } catch {
      setMsConnected(false);
    }
  }, []);

  useEffect(() => {
    loadLists();
    loadTasks();
    loadMsStatus();
  }, [loadLists, loadTasks, loadMsStatus]);

  // Poll every 60s
  useEffect(() => {
    const t = setInterval(loadTasks, 60_000);
    return () => clearInterval(t);
  }, [loadTasks]);

  const filtered = useMemo(() => {
    const tab = STATUS_TABS.find((t) => t.id === activeTab)!;
    return tasks.filter((t) => tab.match.includes(t.status));
  }, [tasks, activeTab]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetchWithRefresh("/api/tasks/sync", { method: "POST", headers: authHeaders() });
      if (res.ok) await loadTasks();
    } finally {
      setSyncing(false);
    }
  }

  async function handleComplete(task: Task) {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "completed" } : t)));
    const res = await fetchWithRefresh(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      // Revert
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    } else {
      await loadTasks();
    }
  }

  if (msConnected === false) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center">
        <h1 className="text-2xl font-bold mb-3" style={{ color: "var(--wp-gold)" }}>Tasks</h1>
        <p className="mb-4" style={{ color: "var(--wp-text-dim)" }}>
          Connect Microsoft To Do in Settings to see your tasks
        </p>
        <a href="/settings" className="inline-block px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}>
          Go to Settings
        </a>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Tasks</h1>
          <a
            href="/planner"
            className="text-xs underline"
            style={{ color: "var(--wp-text-dim)" }}
          >
            View team tasks →
          </a>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="px-3 py-1.5 rounded-md text-sm border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          />
          <select
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
            className="px-3 py-1.5 rounded-md text-sm border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <option value="">All lists</option>
            {lists.map((l) => (
              <option key={l.id} value={l.msListId}>{l.displayName}</option>
            ))}
          </select>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            + New task
          </button>
        </div>
      </div>

      <div role="tablist" className="flex gap-1 mb-4 border-b" style={{ borderColor: "var(--wp-dark-border)" }}>
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2 text-sm font-medium"
            style={{
              color: activeTab === tab.id ? "var(--wp-gold)" : "var(--wp-text-dim)",
              borderBottom: activeTab === tab.id ? "2px solid var(--wp-gold)" : "2px solid transparent",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ul className="space-y-2">
        {filtered.length === 0 && (
          <li className="text-sm py-6 text-center" style={{ color: "var(--wp-text-dim)" }}>
            No tasks in this view.
          </li>
        )}
        {filtered.map((task) => {
          const list = lists.find((l) => l.id === task.listId);
          return (
            <li
              key={task.id}
              className="flex items-center gap-3 p-3 rounded-lg border"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <input
                type="checkbox"
                aria-label={`Complete ${task.title}`}
                checked={task.status === "completed"}
                onChange={() => handleComplete(task)}
              />
              <button
                className="flex-1 text-left"
                onClick={() => setDrawerTask(task)}
              >
                <div className="text-sm font-medium">{task.title}</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim)" }}>
                  {list?.displayName ?? "—"}{task.dueAt ? ` · ${fmtDue(task.dueAt)}` : ""}
                </div>
              </button>
              {task.importance === "high" && (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: "var(--wp-warning)", color: "var(--wp-dark)" }}
                >
                  high
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {drawerTask && (
        <TaskDrawer
          task={drawerTask}
          lists={lists}
          onClose={() => setDrawerTask(null)}
          onSaved={async () => { setDrawerTask(null); await loadTasks(); }}
        />
      )}

      {showNew && (
        <NewTaskModal
          lists={lists}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await loadTasks(); }}
        />
      )}
    </div>
  );
}

function TaskDrawer({
  task, lists, onClose, onSaved,
}: { task: Task; lists: TaskList[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [dueAt, setDueAt] = useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [importance, setImportance] = useState<TaskImportance>(task.importance);
  const [saving, setSaving] = useState(false);

  const listName = lists.find((l) => l.id === task.listId)?.displayName ?? "—";

  async function handleSave() {
    setSaving(true);
    const res = await fetchWithRefresh(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title,
        body,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        importance,
      }),
    });
    setSaving(false);
    if (res.ok) onSaved();
  }

  return (
    <div role="dialog" aria-label="Task details"
      className="fixed inset-0 flex justify-end z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md h-full p-6 overflow-y-auto border-l"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Edit task</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="text-xs mb-2" style={{ color: "var(--wp-text-dim)" }}>List: {listName}</div>
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Notes</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Due</label>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Importance</label>
        <select
          value={importance}
          onChange={(e) => setImportance(e.target.value as TaskImportance)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-4"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full px-3 py-2 rounded-md text-sm font-medium"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function NewTaskModal({
  lists, onClose, onCreated,
}: { lists: TaskList[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [listId, setListId] = useState(lists[0]?.msListId ?? "");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim() || !listId) return;
    setCreating(true);
    const res = await fetchWithRefresh("/api/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ title, listId }),
    });
    setCreating(false);
    if (res.ok) onCreated();
  }

  return (
    <div role="dialog" aria-label="New task"
      className="fixed inset-0 flex items-center justify-center z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm p-6 rounded-lg border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-bold mb-4">New task</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <select
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-4"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        >
          {lists.map((l) => (
            <option key={l.id} value={l.msListId}>{l.displayName}</option>
          ))}
        </select>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 rounded-md text-sm"
            style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !title.trim() || !listId}
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
