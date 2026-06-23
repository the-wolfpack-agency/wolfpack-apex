"use client";

/**
 * /admin/agents/memory: shared agent procedural memory.
 *
 * This is the workspace view of what the agents have LEARNED. When one agent
 * works out how to do a task (the ordered plan of instruction + tool steps),
 * that procedure is recorded once and a later agent can reuse it instead of
 * re-exploring from scratch. The "reused N times" hit count is the
 * inheritance signal: as procedures get inherited, the cost of re-doing a
 * task plateaus toward zero.
 *
 * Safety gate: a learned procedure is QUARANTINED until it passes the safety
 * check. Only PROMOTED procedures are inheritable by other agents; REJECTED
 * ones are kept (with a reason) so the same bad path is not relearned. A human
 * can override the gate either way: promote a quarantined procedure to make it
 * inheritable, or reject one so no agent picks it up.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). The route is capability-gated on the API side.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

type MemoryStatus = "quarantined" | "promoted" | "rejected";

interface PlanStep {
  instruction: string;
  tool: string;
}

interface MemoryEntry {
  id: string;
  workspaceId: string;
  goalKey: string;
  goal: string;
  plan: PlanStep[];
  status: MemoryStatus;
  learnedByAgent: string;
  sourceTaskId: string | null;
  hitCount: number;
  rejectReason: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface MemoryResponse {
  workspace_id: string;
  memory: MemoryEntry[];
}

interface PatchResponse {
  memory: MemoryEntry;
}

/* The status filter options. "all" sends no ?status param; the rest filter the
   list server-side to one status. */
type StatusFilter = "all" | MemoryStatus;

const FILTER_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "promoted", label: "Promoted" },
  { value: "quarantined", label: "Quarantined" },
  { value: "rejected", label: "Rejected" },
];

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* Status-chip colors. Promoted green (inheritable), quarantined amber (held
   pending the safety check), rejected red (kept so the bad path is not
   relearned). Tuned to read on the dark surface, falling back when the
   var(--wp-*) token is absent. */
function statusColor(status: MemoryStatus): { fg: string; bg: string } {
  switch (status) {
    case "promoted":
      return { fg: "var(--wp-success, #22c55e)", bg: "rgba(34,197,94,0.12)" };
    case "quarantined":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    case "rejected":
      return { fg: "var(--wp-error, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

function StatusChip({ status, id }: { status: MemoryStatus; id: string }) {
  const c = statusColor(status);
  return (
    <span
      data-testid={`memory-status-chip-${id}`}
      style={{
        padding: "0.1rem 0.55rem",
        borderRadius: "10px",
        fontSize: "0.7rem",
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.fg}`,
        textTransform: "capitalize",
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function truncate(s: string, max = 140): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/* A single memory row. Holds its own expand + override-in-flight state so one
   row's actions never block another's. The override callback patches the API
   and returns the updated entry, which the parent splices back into the list. */
function MemoryRow({
  entry,
  onOverride,
}: {
  entry: MemoryEntry;
  onOverride: (id: string, action: "promote" | "reject") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"promote" | "reject" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(action: "promote" | "reject") {
    setBusy(action);
    setRowError(null);
    try {
      await onOverride(entry.id, action);
    } catch (e) {
      setRowError((e as Error).message || "Could not update this procedure.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      data-testid={`memory-row-${entry.id}`}
      style={{
        padding: "1rem 1.1rem",
        marginBottom: "0.5rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "8px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <StatusChip status={entry.status} id={entry.id} />
          <span style={{ fontSize: "0.95rem", color: "var(--wp-text, #eee)" }}>
            <strong>{truncate(entry.goal)}</strong>
          </span>
        </div>
        <span
          title={entry.createdAt}
          style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}
        >
          learned {relativeTime(entry.createdAt)}
        </span>
      </div>

      <div
        style={{
          marginTop: "0.45rem",
          fontSize: "0.8rem",
          color: "var(--wp-text-dim, #aaa)",
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <span>
          learned by{" "}
          <strong style={{ color: "var(--wp-text, #eee)" }}>{entry.learnedByAgent}</strong>
        </span>
        <span
          data-testid={`memory-hits-${entry.id}`}
          title="Each reuse is another agent inheriting this procedure instead of re-exploring."
        >
          reused {entry.hitCount} {entry.hitCount === 1 ? "time" : "times"}
        </span>
      </div>

      {entry.status === "rejected" && entry.rejectReason && (
        <div
          data-testid={`memory-reject-reason-${entry.id}`}
          style={{
            marginTop: "0.4rem",
            fontSize: "0.78rem",
            color: "var(--wp-error, #ef4444)",
            fontStyle: "italic",
          }}
        >
          rejected: {entry.rejectReason}
        </div>
      )}

      <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          data-testid={`memory-expand-${entry.id}`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            padding: "0.3rem 0.8rem",
            borderRadius: "6px",
            fontSize: "0.8rem",
            cursor: "pointer",
            background: "var(--wp-dark-surface2, #1a1a1a)",
            color: "var(--wp-text-dim, #aaa)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        >
          {expanded ? "Hide plan" : `Show plan (${entry.plan.length} ${entry.plan.length === 1 ? "step" : "steps"})`}
        </button>

        {entry.status !== "promoted" && (
          <button
            type="button"
            data-testid={`memory-promote-${entry.id}`}
            onClick={() => void run("promote")}
            disabled={busy !== null}
            title="Promoting makes this procedure inheritable by other agents."
            style={{
              padding: "0.3rem 0.9rem",
              borderRadius: "6px",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: busy !== null ? "not-allowed" : "pointer",
              background: "rgba(34,197,94,0.12)",
              color: "var(--wp-success, #22c55e)",
              border: "1px solid var(--wp-success, #22c55e)",
            }}
          >
            {busy === "promote" ? "Promoting..." : "Promote"}
          </button>
        )}

        {entry.status !== "rejected" && (
          <button
            type="button"
            data-testid={`memory-reject-${entry.id}`}
            onClick={() => void run("reject")}
            disabled={busy !== null}
            title="Rejecting keeps this procedure out of every agent's reach."
            style={{
              padding: "0.3rem 0.9rem",
              borderRadius: "6px",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: busy !== null ? "not-allowed" : "pointer",
              background: "rgba(239,68,68,0.10)",
              color: "var(--wp-error, #ef4444)",
              border: "1px solid var(--wp-error, #ef4444)",
            }}
          >
            {busy === "reject" ? "Rejecting..." : "Reject"}
          </button>
        )}
      </div>

      {rowError && (
        <div
          data-testid={`memory-row-error-${entry.id}`}
          style={{
            marginTop: "0.5rem",
            fontSize: "0.78rem",
            color: "var(--wp-error, #ef4444)",
          }}
        >
          {rowError}
        </div>
      )}

      {expanded && (
        <ol
          data-testid={`memory-plan-${entry.id}`}
          style={{
            marginTop: "0.6rem",
            marginBottom: 0,
            paddingLeft: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
          }}
        >
          {entry.plan.length === 0 ? (
            <li style={{ listStyle: "none", marginLeft: "-1.25rem", fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>
              No recorded steps for this procedure.
            </li>
          ) : (
            entry.plan.map((step, i) => (
              <li
                key={i}
                data-testid={`memory-plan-step-${entry.id}-${i}`}
                style={{ fontSize: "0.82rem", color: "var(--wp-text-dim, #aaa)" }}
              >
                <span style={{ color: "var(--wp-text, #eee)" }}>{step.instruction}</span>
                <span
                  style={{
                    marginLeft: "0.5rem",
                    padding: "0.05rem 0.4rem",
                    borderRadius: "8px",
                    fontSize: "0.68rem",
                    fontFamily: "var(--wp-mono, monospace)",
                    background: "rgba(160,160,160,0.10)",
                    color: "var(--wp-text-muted, #6b7280)",
                    border: "1px solid var(--wp-dark-border, #333)",
                  }}
                >
                  {step.tool}
                </span>
              </li>
            ))
          )}
        </ol>
      )}
    </li>
  );
}

export default function AgentMemoryPage() {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status: StatusFilter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = status === "all" ? "" : `?status=${status}`;
      const res = await fetchWithRefresh(`/api/admin/agents/memory${qs}`);
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to view shared agent memory.");
        } else {
          setError(`Could not load agent memory (HTTP ${res.status}).`);
        }
        setMemory([]);
        return;
      }
      const body = (await res.json()) as MemoryResponse;
      setMemory(body.memory ?? []);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setMemory([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  /* Human override. PATCHes the action and splices the updated entry back into
     the list in place so the chip + available buttons reflect the new status
     without a full refetch. If the active filter no longer matches the new
     status, the row drops out (it would not be in a fresh fetch either). */
  const override = useCallback(
    async (id: string, action: "promote" | "reject") => {
      const res = await fetchWithRefresh(`/api/admin/agents/memory/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        throw new Error(`Could not ${action} this procedure (HTTP ${res.status}).`);
      }
      const body = (await res.json()) as PatchResponse;
      const updated = body.memory;
      setMemory((prev) => {
        const next = prev.map((m) => (m.id === id ? updated : m));
        if (filter === "all") return next;
        return next.filter((m) => m.status === filter);
      });
    },
    [filter],
  );

  return (
    <div
      data-testid="admin-agent-memory-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "920px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          Agent memory
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Link
            href="/admin/agents"
            data-testid="memory-roster-link"
            style={{
              fontSize: "0.85rem",
              color: "var(--wp-text-dim, #aaa)",
              textDecoration: "none",
            }}
          >
            Back to roster
          </Link>
          <button
            type="button"
            onClick={() => void load(filter)}
            disabled={loading}
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text-dim, #aaa)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1.5rem 0", fontSize: "0.9rem" }}>
        This is the shared procedural memory agents inherit. One agent learns how
        to do a task, recording it as an ordered plan of steps; a later agent
        reuses that plan instead of re-exploring from scratch. Only procedures
        that pass the safety check are promoted and inheritable. Quarantined ones
        wait for review; rejected ones are kept (with a reason) so the same bad
        path is never relearned. You can promote or reject any procedure by hand.
      </p>

      <div
        data-testid="memory-filter"
        style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1.25rem", flexWrap: "wrap" }}
      >
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              data-testid={`memory-filter-${opt.value}`}
              onClick={() => setFilter(opt.value)}
              aria-pressed={active}
              style={{
                padding: "0.35rem 0.9rem",
                borderRadius: "6px",
                fontSize: "0.85rem",
                cursor: "pointer",
                background: active ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-surface, #1f1f22)",
                color: active ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                border: `1px solid ${active ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
                fontWeight: active ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          data-testid="memory-error"
          style={{
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {!error && !loading && memory.length === 0 && (
        <div
          data-testid="memory-empty"
          style={{
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          {filter === "all"
            ? "No procedures learned yet. As agents complete tasks, the plans they work out land here for review and reuse."
            : `No ${filter} procedures.`}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="memory-list">
        {memory.map((entry) => (
          <MemoryRow key={entry.id} entry={entry} onOverride={override} />
        ))}
      </ul>
    </div>
  );
}
