/**
 * Pure-function tests for detectSlips — no I/O, no mocks.
 */
import { detectSlips } from "@/lib/review/slip-detector";
import type { MsTask } from "@/lib/integrations/microsoft-tasks";

const NOW = new Date("2026-04-21T12:00:00Z");
const NOW_MS = NOW.getTime();
const DAY = 24 * 60 * 60 * 1000;

function mkTask(overrides: Partial<MsTask>): MsTask {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    msTaskId: overrides.msTaskId ?? "ms-task",
    userId: overrides.userId ?? "u1",
    listId: overrides.listId ?? "list-1",
    title: overrides.title ?? "Sample task",
    body: overrides.body ?? null,
    status: overrides.status ?? "notStarted",
    importance: overrides.importance ?? "normal",
    dueAt: overrides.dueAt ?? null,
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(NOW_MS - 7 * DAY).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(NOW_MS - DAY).toISOString(),
    etag: overrides.etag ?? null,
    syncedAt: overrides.syncedAt ?? new Date(NOW_MS).toISOString(),
    payload: overrides.payload ?? {},
  };
}

describe("detectSlips", () => {
  test("empty list returns empty slipped + reasons", () => {
    const res = detectSlips([], NOW);
    expect(res.slipped).toEqual([]);
    expect(res.reasons).toEqual({});
  });

  test("overdue notStarted task is flagged with reason 'overdue'", () => {
    const t = mkTask({
      id: "t-overdue",
      status: "notStarted",
      dueAt: new Date(NOW_MS - DAY).toISOString(),
    });
    const res = detectSlips([t], NOW);
    expect(res.slipped.map((s) => s.id)).toEqual(["t-overdue"]);
    expect(res.reasons["t-overdue"]).toBe("overdue");
  });

  test("overdue inProgress/waitingOnOthers tasks are also flagged (any non-completed)", () => {
    const a = mkTask({ id: "a", status: "inProgress", dueAt: new Date(NOW_MS - DAY).toISOString() });
    const b = mkTask({ id: "b", status: "waitingOnOthers", dueAt: new Date(NOW_MS - 2 * DAY).toISOString() });
    const res = detectSlips([a, b], NOW);
    expect(res.slipped.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(res.reasons.a).toBe("overdue");
    expect(res.reasons.b).toBe("overdue");
  });

  test("overdue but completed task is NOT flagged", () => {
    const t = mkTask({
      id: "done",
      status: "completed",
      dueAt: new Date(NOW_MS - DAY).toISOString(),
      completedAt: new Date(NOW_MS - DAY / 2).toISOString(),
    });
    const res = detectSlips([t], NOW);
    expect(res.slipped).toEqual([]);
  });

  test("dueAt === now is NOT overdue (strict < comparison)", () => {
    const t = mkTask({
      id: "edge",
      status: "notStarted",
      dueAt: NOW.toISOString(),
      createdAt: new Date(NOW_MS - 10 * DAY).toISOString(),
    });
    const res = detectSlips([t], NOW);
    // Not overdue (strict <). Not carried-forward either — due is NOT within
    // the next 24h *strictly after* now + edge case: due >= now AND
    // due - now <= DAY. Our guard is inclusive of both endpoints, so this
    // one DOES qualify as carried-forward since created 10d earlier.
    expect(res.reasons[t.id]).toBe("carried_forward");
  });

  test("carried-forward heuristic: notStarted + created ≥3d before dueAt + due within 24h", () => {
    const t = mkTask({
      id: "carry",
      status: "notStarted",
      dueAt: new Date(NOW_MS + 5 * 60 * 60 * 1000).toISOString(), // 5h away
      createdAt: new Date(NOW_MS - 5 * DAY).toISOString(), // 5d old
    });
    const res = detectSlips([t], NOW);
    expect(res.reasons["carry"]).toBe("carried_forward");
  });

  test("carried-forward NOT triggered when createdAt is < 3d before dueAt", () => {
    const due = new Date(NOW_MS + 2 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(NOW_MS - 2 * DAY).toISOString(); // due - created = 2d+2h < 3d
    const t = mkTask({ id: "fresh", status: "notStarted", dueAt: due, createdAt });
    const res = detectSlips([t], NOW);
    expect(res.slipped).toEqual([]);
  });

  test("carried-forward NOT triggered when task is inProgress (not notStarted)", () => {
    const t = mkTask({
      id: "progress",
      status: "inProgress",
      dueAt: new Date(NOW_MS + 3 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(NOW_MS - 10 * DAY).toISOString(),
    });
    const res = detectSlips([t], NOW);
    expect(res.slipped).toEqual([]);
  });

  test("tasks without dueAt are ignored", () => {
    const t = mkTask({ id: "nodate", status: "notStarted", dueAt: null });
    const res = detectSlips([t], NOW);
    expect(res.slipped).toEqual([]);
  });

  test("malformed dueAt strings are ignored, not thrown", () => {
    const t = mkTask({ id: "bad", status: "notStarted", dueAt: "not-a-date" });
    const res = detectSlips([t], NOW);
    expect(res.slipped).toEqual([]);
  });
});
