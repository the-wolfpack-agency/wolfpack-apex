"use client";

/**
 * Planner — Microsoft Planner (shared team tasks) kanban.
 *
 * Reads from /api/planner/* (all backed by the local cache). Writes go
 * through the API, which write-throughs to Graph + upserts cache. Drag
 * and drop is deferred — cards expose an explicit "Move to bucket" menu.
 *
 * Mobile + desktop responsive: columns wrap on narrow screens; drawer
 * takes full width below 640px.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface Group { id: string; msGroupId: string; displayName: string }
interface Plan { id: string; msPlanId: string; title: string; groupId: string | null; msContainerType: "group" | "roster" }
interface Bucket { id: string; msBucketId: string; name: string }
interface Task {
  id: string;
  msTaskId: string;
  planId: string;
  bucketId: string | null;
  title: string;
  dueAt: string | null;
  percentComplete: number;
  priority: number;
  assignees: string[];
  etag: string | null;
}

function fmtDue(s: string | null): string {
  if (!s) return "";
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function priorityLabel(p: number): string {
  if (p <= 2) return "urgent";
  if (p <= 4) return "important";
  if (p <= 6) return "medium";
  return "low";
}

export default function PlannerPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groupId, setGroupId] = useState<string>("");
  const [planId, setPlanId] = useState<string>("");
  const [msConnected, setMsConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [newBucketId, setNewBucketId] = useState<string | null>(null);
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);

  const loadGroups = useCallback(async () => {
    const res = await fetchWithRefresh("/api/groups", { headers: authHeaders() });
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) return;
    const data = await res.json();
    setGroups(data.groups || []);
  }, []);

  const loadPlans = useCallback(async () => {
    const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
    const res = await fetchWithRefresh(`/api/planner/plans${qs}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    setPlans(data.plans || []);
  }, [groupId]);

  const loadBuckets = useCallback(async () => {
    if (!planId) { setBuckets([]); return; }
    const res = await fetchWithRefresh(`/api/planner/plans/${encodeURIComponent(planId)}/buckets`, { headers: authHeaders() });
    if (!res.ok) { setBuckets([]); return; }
    const data = await res.json();
    setBuckets(data.buckets || []);
  }, [planId]);

  const loadTasks = useCallback(async () => {
    if (!planId) { setTasks([]); return; }
    const res = await fetchWithRefresh(`/api/planner/plans/${encodeURIComponent(planId)}/tasks`, { headers: authHeaders() });
    if (!res.ok) { setTasks([]); return; }
    const data = await res.json();
    setTasks(data.tasks || []);
  }, [planId]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/integrations/status", { headers: authHeaders() });
      if (!res.ok) { setMsConnected(false); return; }
      const data = await res.json();
      setMsConnected(!!(data?.microsoft?.connected ?? data?.microsoft));
    } catch { setMsConnected(false); }
  }, []);

  useEffect(() => { loadStatus(); loadGroups(); }, [loadStatus, loadGroups]);
  useEffect(() => { loadPlans(); }, [loadPlans]);
  useEffect(() => { loadBuckets(); loadTasks(); }, [loadBuckets, loadTasks]);

  async function handleSync() {
    setSyncing(true);
    try {
      // Groups first so Planner sync has groups to walk.
      await fetchWithRefresh("/api/groups/sync", { method: "POST", headers: authHeaders() });
      await fetchWithRefresh("/api/planner/sync", { method: "POST", headers: authHeaders() });
      await loadGroups();
      await loadPlans();
      await loadBuckets();
      await loadTasks();
    } finally { setSyncing(false); }
  }

  const columns = useMemo(() => {
    // One column per bucket; unbucketed tasks go into a trailing "No bucket" column.
    const byBucket: Record<string, Task[]> = {};
    for (const b of buckets) byBucket[b.id] = [];
    const unbucketed: Task[] = [];
    for (const t of tasks) {
      if (t.bucketId && byBucket[t.bucketId]) byBucket[t.bucketId].push(t);
      else unbucketed.push(t);
    }
    const cols = buckets.map((b) => ({ id: b.id, name: b.name, tasks: byBucket[b.id] }));
    if (unbucketed.length > 0) cols.push({ id: "", name: "No bucket", tasks: unbucketed });
    // If plan has no buckets at all, show a single column of all tasks.
    if (cols.length === 0 && tasks.length > 0) cols.push({ id: "", name: "All", tasks });
    return cols;
  }, [buckets, tasks]);

  if (msConnected === false) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center px-4">
        <h1 className="text-2xl font-bold mb-3" style={{ color: "var(--wp-gold)" }}>Planner</h1>
        <p className="mb-4" style={{ color: "var(--wp-text-dim)" }}>
          Connect Microsoft 365 in Settings to see shared team tasks
        </p>
        <a href="/settings" className="inline-block px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}>
          Go to Settings
        </a>
      </div>
    );
  }

  return (
    <div className="px-2 sm:px-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Planner</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Group"
            value={groupId}
            onChange={(e) => { setGroupId(e.target.value); setPlanId(""); }}
            className="px-3 py-1.5 rounded-md text-sm border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.displayName}</option>
            ))}
          </select>
          <select
            aria-label="Plan"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            className="px-3 py-1.5 rounded-md text-sm border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <option value="">Select plan…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
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
        </div>
      </div>

      {groups.length === 0 && (
        <div className="rounded-lg border p-6 text-center"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <div className="text-sm mb-2" style={{ color: "var(--wp-text-dim)" }}>
            No groups synced yet. Click <span className="font-medium">Sync now</span> to pull
            your Microsoft 365 groups + Planner plans.
          </div>
        </div>
      )}

      {groups.length > 0 && plans.length === 0 && planId === "" && (
        <div className="text-sm py-6 text-center" style={{ color: "var(--wp-text-dim)" }}>
          No plans in this group — pick a different group or sync again.
        </div>
      )}

      {planId && (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {columns.length === 0 && (
            <div className="flex-1 text-sm py-6 text-center" style={{ color: "var(--wp-text-dim)" }}>
              No tasks in this plan yet.
            </div>
          )}
          {columns.map((col) => (
            <div key={col.id || "none"}
              className="w-72 shrink-0 rounded-lg border p-3"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <div className="flex justify-between items-center mb-2">
                <div className="text-sm font-semibold">{col.name}</div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>{col.tasks.length}</div>
              </div>
              <ul className="space-y-2 mb-2">
                {col.tasks.map((task) => (
                  <li key={task.id}
                    className="p-2 rounded border cursor-pointer"
                    style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                    onClick={() => setDrawerTask(task)}
                  >
                    <div className="text-sm font-medium">{task.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      {task.dueAt && (
                        <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                          {fmtDue(task.dueAt)}
                        </span>
                      )}
                      <span className="text-xs px-1.5 py-0.5 rounded"
                        style={{ background: "var(--wp-dark-surface)", color: "var(--wp-text-dim)" }}
                      >
                        {priorityLabel(task.priority)}
                      </span>
                      {task.assignees.length > 0 && (
                        <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                          · {task.assignees.length} assigned
                        </span>
                      )}
                    </div>
                    {task.percentComplete > 0 && (
                      <div className="mt-2 h-1 rounded overflow-hidden"
                        style={{ background: "var(--wp-dark-surface)" }}
                      >
                        <div style={{
                          width: `${task.percentComplete}%`,
                          height: "100%",
                          background: "var(--wp-gold)",
                        }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {col.id && (
                <button
                  onClick={() => setNewBucketId(col.id)}
                  className="w-full px-2 py-1.5 rounded-md text-xs"
                  style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
                >
                  + New task
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {drawerTask && (
        <TaskDrawer
          task={drawerTask}
          buckets={buckets}
          onClose={() => setDrawerTask(null)}
          onSaved={async () => { setDrawerTask(null); await loadTasks(); }}
        />
      )}
      {newBucketId !== null && planId && (
        <NewTaskModal
          planId={planId}
          bucketId={newBucketId}
          onClose={() => setNewBucketId(null)}
          onCreated={async () => { setNewBucketId(null); await loadTasks(); }}
        />
      )}
    </div>
  );
}

function TaskDrawer({
  task, buckets, onClose, onSaved,
}: { task: Task; buckets: Bucket[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [dueAt, setDueAt] = useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [bucketId, setBucketId] = useState<string>(task.bucketId ?? "");
  const [percent, setPercent] = useState<number>(task.percentComplete);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    if (!task.etag) { setErr("Missing etag — refresh the page and retry."); return; }
    setSaving(true);
    setErr(null);
    const res = await fetchWithRefresh(`/api/planner/tasks/${task.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        bucketId: bucketId || null,
        percentComplete: percent,
        etag: task.etag,
      }),
    });
    setSaving(false);
    if (res.status === 409) { setErr("Task changed by someone else — reload and try again."); return; }
    if (!res.ok) { setErr("Save failed."); return; }
    onSaved();
  }

  async function handleComplete() {
    if (!task.etag) { setErr("Missing etag — refresh the page and retry."); return; }
    setSaving(true);
    const res = await fetchWithRefresh(`/api/planner/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ etag: task.etag }),
    });
    setSaving(false);
    if (!res.ok) { setErr("Complete failed."); return; }
    onSaved();
  }

  return (
    <div role="dialog" aria-label="Planner task" className="fixed inset-0 flex justify-end z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-md h-full p-5 overflow-y-auto border-l"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Task details</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Bucket</label>
        <select
          value={bucketId}
          onChange={(e) => setBucketId(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        >
          <option value="">No bucket</option>
          {buckets.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Due</label>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim)" }}>Progress ({percent}%)</label>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          onChange={(e) => setPercent(parseInt(e.target.value, 10))}
          className="w-full mb-4"
        />
        {err && <div className="text-xs mb-3" style={{ color: "var(--wp-warning)" }}>{err}</div>}
        <div className="flex gap-2">
          <button
            onClick={handleComplete}
            disabled={saving || task.percentComplete === 100}
            className="flex-1 px-3 py-2 rounded-md text-sm"
            style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
          >
            {task.percentComplete === 100 ? "Completed" : "Complete"}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewTaskModal({
  planId, bucketId, onClose, onCreated,
}: { planId: string; bucketId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleCreate() {
    if (!title.trim()) return;
    setCreating(true);
    setErr(null);
    const res = await fetchWithRefresh("/api/planner/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ planId, bucketId: bucketId || undefined, title }),
    });
    setCreating(false);
    if (!res.ok) { setErr("Create failed."); return; }
    onCreated();
  }

  return (
    <div role="dialog" aria-label="New Planner task"
      className="fixed inset-0 flex items-center justify-center z-50 px-4" onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm p-5 rounded-lg border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-bold mb-3">New task</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          className="w-full px-3 py-2 rounded-md text-sm border mb-3"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        />
        {err && <div className="text-xs mb-3" style={{ color: "var(--wp-warning)" }}>{err}</div>}
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
            disabled={creating || !title.trim()}
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
