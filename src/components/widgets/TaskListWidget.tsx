/**
 * TaskListWidget — inline list of the user's open tasks.
 *
 * Each row supports:
 *   - Inline check-off (PATCH /api/ms-tasks/[listId]/[taskId] status=completed)
 *     with an optimistic UI update + analytics on success.
 *   - Click on the title → open the task in the /tasks page.
 *
 * The widget keeps a local "completed" set so toggling a row immediately
 * crosses it out without needing the spec to refresh. The persisted spec
 * (in message metadata) doesn't mutate — on reload, the row reappears
 * as open until the next sync. Cheap, predictable, no refetch needed.
 */

"use client";

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { TaskListWidgetSpec, TaskListItem } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function formatDue(iso: string | null): { label: string; overdue: boolean } {
  if (!iso) return { label: "", overdue: false };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { label: "", overdue: false };
  const now = Date.now();
  const overdue = t < now;
  const diff = t - now;
  const day = 24 * 60 * 60 * 1000;
  if (overdue) {
    const daysOver = Math.ceil((now - t) / day);
    if (daysOver < 1) return { label: "overdue", overdue: true };
    return { label: `${daysOver}d overdue`, overdue: true };
  }
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 24) return { label: `due in ${hrs}h`, overdue: false };
  const days = Math.floor(hrs / 24);
  if (days < 7) return { label: `due in ${days}d`, overdue: false };
  return {
    label: `due ${new Date(t).toLocaleDateString("default", { month: "short", day: "numeric" })}`,
    overdue: false,
  };
}

export interface TaskListWidgetProps {
  spec: TaskListWidgetSpec;
  workflowId?: string;
}

export function TaskListWidget({ spec, workflowId }: TaskListWidgetProps) {
  const [completedLocal, setCompletedLocal] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  /* Closed over workflowId so every interaction event carries the
   * funnel correlation id when the widget came from a chat() turn. */
  function trackInteraction(action: string, taskId?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "task_list",
          action,
          task_id: taskId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "task_list",
          task_count: spec.tasks.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.tasks.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "task_list",
    itemCount: spec.tasks.length,
    workflowId,
  });

  async function completeTask(task: TaskListItem) {
    if (pending.has(task.id) || completedLocal.has(task.id)) return;
    setPending((s) => new Set(s).add(task.id));
    try {
      const res = await fetchWithRefresh(`/api/tasks/${encodeURIComponent(task.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setCompletedLocal((s) => new Set(s).add(task.id));
        trackInteraction("complete_task", task.id);
      } else {
        trackInteraction("complete_task_failed", task.id);
      }
    } catch {
      trackInteraction("complete_task_error", task.id);
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <div
      data-testid="task-list-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        className="flex items-center justify-between mb-2"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        <div>
          <div className="text-sm font-semibold">{spec.title}</div>
          {spec.subtitle && (
            <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              {spec.subtitle}
            </div>
          )}
        </div>
        <a
          href="/tasks"
          onClick={() => trackInteraction("open_tasks_page")}
          className="text-xs"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Open full tasks
        </a>
      </div>

      {spec.tasks.length === 0 ? (
        <div
          data-testid="task-list-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          You have no open tasks.
        </div>
      ) : (
        <ul className="space-y-1">
          {spec.tasks.map((t, idx) => {
            const done = completedLocal.has(t.id);
            const isPending = pending.has(t.id);
            const due = formatDue(t.dueAt);
            return (
              <StaggeredItem
                key={t.id}
                index={idx}
                data-testid={`task-list-item-${t.id}`}
                className="text-xs rounded px-2 py-1.5 flex items-start gap-2"
                style={{
                  background: "var(--wp-dark, #111)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  /* Reveal animation finishes in <250ms; user-driven
                   * complete (which sets `done`) happens long after,
                   * so the dim takes effect without competing with
                   * the animation's opacity track. */
                  opacity: done ? 0.6 : undefined,
                }}
              >
                <button
                  data-testid={`task-list-complete-${t.id}`}
                  onClick={() => completeTask(t)}
                  disabled={done || isPending}
                  aria-label={done ? "Completed" : "Mark complete"}
                  className="flex-none w-4 h-4 rounded border mt-0.5"
                  style={{
                    borderColor: done
                      ? "var(--wp-gold, #eab308)"
                      : "var(--wp-text-muted, #6b7280)",
                    background: done ? "var(--wp-gold, #eab308)" : "transparent",
                    cursor: done || isPending ? "default" : "pointer",
                  }}
                />
                <div className="flex-1 min-w-0">
                  <a
                    href={`/tasks?focus=${encodeURIComponent(t.id)}`}
                    onClick={() => trackInteraction("open_task_detail", t.id)}
                    className={`block truncate ${done ? "line-through" : ""}`}
                    style={{ color: "var(--wp-text, #eee)" }}
                  >
                    {t.title}
                  </a>
                  <div
                    className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    {t.importance === "high" && (
                      <span style={{ color: "#f87171" }}>high</span>
                    )}
                    {due.label && (
                      <span style={{ color: due.overdue ? "#f87171" : undefined }}>
                        {due.label}
                      </span>
                    )}
                  </div>
                </div>
              </StaggeredItem>
            );
          })}
        </ul>
      )}
    </div>
  );
}
