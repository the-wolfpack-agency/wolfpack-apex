"use client";

/**
 * Tasks — Microsoft To Do integration.
 *
 * Reads come from /api/tasks (local cache). Writes go through the API,
 * which write-throughs to Graph. Poll every 60s + refetch after sync.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import AssigneePicker from "@/components/AssigneePicker";

type TaskStatus = "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";
type TaskImportance = "low" | "normal" | "high";

interface TaskList {
  id: string;
  msListId: string;
  displayName: string;
}

interface Plan {
  id: string;
  msPlanId: string;
  title: string;
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
  startAt: string | null;
  reminderAt: string | null;
  isReminderOn: boolean;
  categories: string[];
  completedAt: string | null;
}

/** Convert an ISO string to the value a <input type="datetime-local"> expects. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseCategories(raw: string): string[] {
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
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

  async function handleToggleComplete(task: Task) {
    const nextStatus: TaskStatus =
      task.status === "completed" ? "notStarted" : "completed";
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)),
    );
    // Use PATCH for the general case (completed → open needs an arbitrary
    // status change; the /complete endpoint only one-ways to completed).
    const res = await fetchWithRefresh(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ status: nextStatus }),
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
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="px-3 py-1.5 rounded-md text-sm border flex-1 min-w-[8rem] sm:flex-none sm:w-auto"
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
              className="flex items-center gap-3 p-3 rounded-lg border wp-hover-lift outline-none"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <input
                type="checkbox"
                aria-label={
                  task.status === "completed"
                    ? `Reopen ${task.title}`
                    : `Complete ${task.title}`
                }
                checked={task.status === "completed"}
                onChange={() => handleToggleComplete(task)}
              />
              <button
                className="flex-1 text-left"
                onClick={() => setDrawerTask(task)}
              >
                <div className="text-sm font-medium">{task.title}</div>
                <div className="text-xs mt-0.5 flex items-center gap-1 flex-wrap" style={{ color: "var(--wp-text-dim)" }}>
                  <span>{list?.displayName ?? "—"}{task.dueAt ? ` · ${fmtDue(task.dueAt)}` : ""}</span>
                  {task.isReminderOn && task.reminderAt && (
                    <span aria-label="Reminder set" title="Reminder set">· 🔔</span>
                  )}
                  {(task.categories ?? []).map((c) => (
                    <span
                      key={c}
                      className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
                    >
                      {c}
                    </span>
                  ))}
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
          onCreated={async () => { setShowNew(false); await Promise.all([loadTasks(), loadLists()]); }}
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
  const [startAt, setStartAt] = useState(task.startAt ? task.startAt.slice(0, 10) : "");
  const [reminderAt, setReminderAt] = useState(toLocalInput(task.reminderAt));
  const [categories, setCategories] = useState((task.categories ?? []).join(", "));
  const [importance, setImportance] = useState<TaskImportance>(task.importance);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listName = lists.find((l) => l.id === task.listId)?.displayName ?? "—";

  async function handleSave() {
    setError(null);
    setSaving(true);
    const res = await fetchWithRefresh(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title,
        body,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        startAt: startAt ? new Date(startAt).toISOString() : null,
        reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null,
        categories: parseCategories(categories),
        importance,
      }),
    });
    setSaving(false);
    if (res.ok) return onSaved();
    const b = await res.json().catch(() => ({}));
    setError((b as { error?: string }).error || `Save failed (HTTP ${res.status})`);
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${task.title}"? This removes it from Microsoft To Do too.`)) return;
    setError(null);
    setDeleting(true);
    const res = await fetchWithRefresh(`/api/tasks/${task.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    setDeleting(false);
    if (res.ok) return onSaved();
    const b = await res.json().catch(() => ({}));
    setError((b as { error?: string }).error || `Delete failed (HTTP ${res.status})`);
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
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Start</label>
        <input
          type="date"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          aria-label="Start date"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Due</label>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          aria-label="Due date"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Reminder</label>
        <input
          type="datetime-local"
          value={reminderAt}
          onChange={(e) => setReminderAt(e.target.value)}
          aria-label="Reminder"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Categories (comma-separated)</label>
        <input
          type="text"
          value={categories}
          onChange={(e) => setCategories(e.target.value)}
          placeholder="e.g. Client, Urgent"
          aria-label="Categories"
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
        {error && (
          <p
            data-testid="task-drawer-error"
            className="text-xs mb-3"
            style={{ color: "var(--wp-error, #ef4444)" }}
          >
            {error}
          </p>
        )}
        <button
          onClick={handleSave}
          disabled={saving || deleting}
          className="w-full px-3 py-2 rounded-md text-sm font-medium mb-2"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={handleDelete}
          disabled={saving || deleting}
          data-testid="task-drawer-delete"
          className="w-full px-3 py-2 rounded-md text-sm font-medium border"
          style={{
            background: "transparent",
            borderColor: "var(--wp-error, #ef4444)",
            color: "var(--wp-error, #ef4444)",
          }}
        >
          {deleting ? "Deleting…" : "Delete task"}
        </button>
      </div>
    </div>
  );
}

// Microsoft To Do special lists that Graph accepts writes for but do
// not show up in the user's normal To Do UI (populated from email
// flags, etc.). Filter from the "New task" target dropdown so users
// don't think their task vanished.
const READ_ONLY_LIST_NAMES = new Set<string>([
  "Flagged Emails",
  "Flagged emails",
  "flaggedEmails",
]);

function isWritableList(l: TaskList): boolean {
  return !READ_ONLY_LIST_NAMES.has(l.displayName);
}

function fireAssigned(assigneeCount: number, planId: string) {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      event: "tasks.task_assigned",
      metadata: { context: "tasks", assignee_count: assigneeCount, plan_id: planId },
    }),
  }).catch(() => undefined);
}

function NewTaskModal({
  lists, onClose, onCreated,
}: { lists: TaskList[]; onClose: () => void; onCreated: () => void }) {
  const writableLists = useMemo(() => lists.filter(isWritableList), [lists]);
  const [title, setTitle] = useState("");
  // Empty listId = create in the user's DEFAULT To Do list (resolved server-
  // side). The user does not have to pick a list; a specific one is optional.
  const [listId, setListId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [categories, setCategories] = useState("");
  const [importance, setImportance] = useState<TaskImportance>("normal");
  // Assignment (To Do can't assign — a chosen assignee promotes this to a
  // shared Planner task, the only Graph surface with `assignments`).
  const [assignees, setAssignees] = useState<string[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState("");
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assigning = assignees.length > 0;

  // Lazy-load Planner plans the first time the user starts assigning.
  useEffect(() => {
    if (!assigning || plansLoaded) return;
    let cancelled = false;
    (async () => {
      const res = await fetchWithRefresh("/api/planner/plans", { headers: authHeaders() });
      if (!res.ok) { if (!cancelled) setPlansLoaded(true); return; }
      const data = await res.json();
      if (cancelled) return;
      const list: Plan[] = data.plans || [];
      setPlans(list);
      if (list.length === 1) setPlanId(list[0].id);
      setPlansLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [assigning, plansLoaded]);

  async function handleCreate() {
    if (!title.trim()) return;
    setError(null);

    if (assigning) {
      // Assignment path → Planner (shared team task with assignees).
      if (!planId) { setError("Pick a plan to assign this task to a teammate."); return; }
      setCreating(true);
      const res = await fetchWithRefresh("/api/planner/tasks", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          planId,
          title: title.trim(),
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          assignees,
        }),
      });
      setCreating(false);
      if (res.ok) { fireAssigned(assignees.length, planId); return onCreated(); }
      const b = await res.json().catch(() => ({}));
      setError((b as { message?: string; error?: string }).message
        || (b as { error?: string }).error
        || `Assign failed (HTTP ${res.status}).`);
      return;
    }

    // Personal To Do path (no assignee).
    setCreating(true);
    const res = await fetchWithRefresh("/api/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title,
        listId,
        startAt: startAt ? new Date(startAt).toISOString() : null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null,
        categories: parseCategories(categories),
        importance,
      }),
    });
    setCreating(false);
    if (res.ok) return onCreated();
    const b = await res.json().catch(() => ({}));
    setError(
      (b as { error?: string }).error ||
        `Create failed (HTTP ${res.status}). The task was NOT written to Microsoft To Do.`,
    );
  }

  const inputStyle = { background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" };

  return (
    <div role="dialog" aria-label="New task"
      className="fixed inset-0 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm p-6 rounded-lg border max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-bold mb-4">New task</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          aria-label="Task title"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={inputStyle}
        />

        {!assigning && (
          <select
            data-testid="new-task-list-select"
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            aria-label="List"
            className="w-full px-3 py-2 rounded-md text-sm border mb-3"
            style={inputStyle}
          >
            {/* Empty value targets the user's DEFAULT To Do list server-side. */}
            <option value="">Default list (your To Do)</option>
            {writableLists.map((l) => (
              <option key={l.id} value={l.msListId}>{l.displayName}</option>
            ))}
          </select>
        )}

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Start</label>
            <input type="date" value={startAt} onChange={(e) => setStartAt(e.target.value)}
              aria-label="Start date" className="w-full px-2 py-1.5 rounded-md text-sm border" style={inputStyle} />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Due</label>
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
              aria-label="Due date" className="w-full px-2 py-1.5 rounded-md text-sm border" style={inputStyle} />
          </div>
        </div>

        {!assigning && (
          <>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Reminder</label>
            <input type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)}
              aria-label="Reminder" className="w-full px-3 py-2 rounded-md text-sm border mb-3" style={inputStyle} />

            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Categories (comma-separated)</label>
            <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)}
              placeholder="e.g. Client, Urgent" aria-label="Categories"
              className="w-full px-3 py-2 rounded-md text-sm border mb-3" style={inputStyle} />

            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Importance</label>
            <select value={importance} onChange={(e) => setImportance(e.target.value as TaskImportance)}
              aria-label="Importance" className="w-full px-3 py-2 rounded-md text-sm border mb-3" style={inputStyle}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </>
        )}

        {/* Assignment — the headline gap. Choosing a teammate promotes the task
            to a shared Planner task (To Do has no assignments in Graph). */}
        <div className="mb-3 pt-3 border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
          <AssigneePicker
            context="tasks"
            value={assignees}
            onChange={(ids) => setAssignees(ids)}
            label="Assign to a teammate"
          />
          {assigning && (
            <div className="mt-2" data-testid="assign-plan-block">
              <p className="text-[11px] mb-1" style={{ color: "var(--wp-text-dim)" }}>
                Assigned tasks become shared Planner tasks. Pick the plan it belongs to:
              </p>
              <select
                data-testid="assign-plan-select"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                aria-label="Planner plan"
                className="w-full px-3 py-2 rounded-md text-sm border"
                style={inputStyle}
              >
                <option value="">Select a plan…</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              {plansLoaded && plans.length === 0 && (
                <p className="text-[11px] mt-1" style={{ color: "var(--wp-text-dim)" }}>
                  No Planner plans found. Open <a href="/planner" className="underline">Planner</a> and Sync to pull your plans.
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <p
            data-testid="new-task-error"
            className="text-xs mb-3"
            style={{ color: "var(--wp-error, #ef4444)" }}
          >
            {error}
          </p>
        )}
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
            disabled={creating || !title.trim() || (assigning && !planId)}
            data-testid="new-task-create"
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium"
            style={{
              background: !title.trim() ? "var(--wp-dark-surface2)" : "var(--wp-gold)",
              color: !title.trim() ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark)",
              cursor: creating || !title.trim() ? "not-allowed" : "pointer",
            }}
          >
            {creating ? (assigning ? "Assigning…" : "Creating…") : (assigning ? "Assign task" : "Create")}
          </button>
        </div>
      </div>
    </div>
  );
}
