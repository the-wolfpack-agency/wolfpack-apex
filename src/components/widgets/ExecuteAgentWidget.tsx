"use client";

/**
 * ExecuteAgentWidget — the agent control plane inside the assistant chat.
 *
 * Pick an agent, fill in the task template (Objective + Success criteria
 * required, Context optional), and submit. It POSTs to the same governed task
 * API the detail page uses (/api/admin/agents/[id]/tasks), so the agent runs
 * the work under its own identity, gated by OGIAM and the constitution. The
 * template fields and validation are the shared source in
 * @/lib/agents/tasks/template, so this form and the detail page never drift.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type { ExecuteAgentWidgetSpec } from "@/lib/assistant/widgets/types";
import type { AgentTask } from "@/lib/agents/tasks/types";
import {
  TASK_TEMPLATE_FIELDS,
  validateTaskTemplate,
  type TaskTemplateInput,
} from "@/lib/agents/tasks/template";

export interface ExecuteAgentWidgetProps {
  spec: ExecuteAgentWidgetSpec;
  workflowId?: string;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.45rem 0.55rem",
  background: "var(--wp-dark, #111)",
  color: "var(--wp-text, #eee)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: "6px",
  fontSize: "0.82rem",
  fontFamily: "inherit",
  resize: "vertical",
};

/** The textarea fields of the template (objective, success criteria, context).
 *  The connection-typed field is omitted here: connections are per-agent and
 *  the chat widget keeps to the required + context fields. */
const TEXT_FIELDS = TASK_TEMPLATE_FIELDS.filter((f) => f.kind === "textarea");

type FieldKey = "objective" | "successCriteria" | "context";

export function ExecuteAgentWidget({ spec, workflowId }: ExecuteAgentWidgetProps) {
  const firstActive = useMemo(
    () => spec.agents.find((a) => a.state === "active") ?? spec.agents[0],
    [spec.agents],
  );
  const [agentId, setAgentId] = useState(spec.preselectedAgentId ?? firstActive?.id ?? "");
  const [values, setValues] = useState<Record<FieldKey, string>>({
    objective: "",
    successCriteria: "",
    context: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentTask | null>(null);

  const track = useCallback(
    (action: string, value?: Record<string, unknown>) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.widget_interaction",
          metadata: {
            widget_kind: "execute_agent",
            action,
            ...(value ?? {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    },
    [workflowId],
  );

  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "execute_agent",
          agent_count: spec.agents.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [workflowId, spec.agents.length]);

  const selected = spec.agents.find((a) => a.id === agentId) ?? null;
  const canSubmit =
    !!agentId &&
    selected?.state === "active" &&
    values.objective.trim().length > 0 &&
    values.successCriteria.trim().length > 0 &&
    !submitting;

  async function handleSubmit() {
    if (!agentId) {
      setError("Choose an agent.");
      return;
    }
    // Validate with the SAME rules the server enforces (shared template).
    const input: TaskTemplateInput = {
      objective: values.objective,
      successCriteria: values.successCriteria,
      context: values.context || undefined,
    };
    const parsed = validateTaskTemplate(input);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    track("submit_started", { agent_id: agentId });
    try {
      const res = await fetchWithRefresh(
        spec.submitUrlTemplate.replace("{id}", encodeURIComponent(agentId)),
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ ...parsed.value, source: "chat_widget" }),
        },
      );
      if (res.status === 201 || res.ok) {
        const body = (await res.json()) as { task: AgentTask };
        setResult(body.task);
        track("submit_completed", { agent_id: agentId, status: body.task?.status });
        return;
      }
      if (res.status === 403) {
        setError("You do not have permission to run this agent.");
      } else if (res.status === 409) {
        setError("That agent must be active to run work.");
      } else if (res.status === 404) {
        setError("That agent no longer exists.");
      } else if (res.status === 400) {
        const b = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setError(b.detail || b.error || "The task is not valid.");
      } else {
        setError(`Could not run the agent (HTTP ${res.status}).`);
      }
      track("submit_failed", { agent_id: agentId, status: res.status });
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="execute-agent-widget"
      className="mt-2 rounded-md p-3 space-y-2"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="text-sm font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
        Run an agent
      </div>

      <div>
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #9ca3af)" }}>
          Agent
        </label>
        <select
          data-testid="execute-agent-select"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setResult(null);
            track("agent_picked", { agent_id: e.target.value });
          }}
          disabled={submitting}
          style={INPUT_STYLE}
        >
          {spec.agents.length === 0 && <option value="">No agents onboarded</option>}
          {spec.agents.map((a) => (
            <option key={a.id} value={a.id} disabled={a.state !== "active"}>
              {a.name}
              {a.state !== "active" ? ` (${a.state})` : ""}
            </option>
          ))}
        </select>
      </div>

      {TEXT_FIELDS.map((f) => {
        const key = f.key as FieldKey;
        return (
          <div key={key}>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #9ca3af)" }}>
              {f.label}
              {f.required ? (
                <span style={{ color: "var(--wp-gold, #e8b528)" }}> *</span>
              ) : (
                <span style={{ color: "var(--wp-text-muted, #6b7280)" }}> (optional)</span>
              )}
            </label>
            <textarea
              data-testid={`execute-agent-${key}`}
              value={values[key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
              disabled={submitting}
              rows={key === "objective" ? 3 : 2}
              placeholder={f.placeholder}
              style={INPUT_STYLE}
            />
          </div>
        );
      })}

      {error && (
        <div
          data-testid="execute-agent-error"
          className="text-xs rounded px-2 py-1"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          {error}
        </div>
      )}

      {result && (
        <div
          data-testid="execute-agent-result"
          className="text-xs rounded px-2 py-1 space-y-1"
          style={{
            background: "rgba(74,222,128,0.06)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text-dim, #aaa)",
          }}
        >
          <div style={{ color: result.status === "succeeded" ? "#4ade80" : "#e8b528" }}>
            {result.status === "succeeded" ? "✓" : "•"} {selected?.name ?? "Agent"} — {result.status}
            {" "}({result.steps.length} step{result.steps.length === 1 ? "" : "s"})
          </div>
          {result.resultSummary && <div>{result.resultSummary}</div>}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="execute-agent-submit"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="px-3 py-1.5 rounded text-xs font-semibold"
          style={{
            background: canSubmit ? "var(--wp-gold, #e8b528)" : "var(--wp-dark, #111)",
            color: canSubmit ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #6b7280)",
            border: "1px solid var(--wp-dark-border, #333)",
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "Running…" : "Run task"}
        </button>
      </div>
    </div>
  );
}
