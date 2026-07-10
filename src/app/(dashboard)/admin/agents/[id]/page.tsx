"use client";

/**
 * /admin/agents/[id]: profile + lifecycle controls for one agent principal.
 *
 * Shows the agent's identity (id, identity provider, external subject), role,
 * owner, current state, scan status, and the relative timeline (created,
 * activated, last seen). Lifecycle buttons pause, resume, or revoke the agent
 * via PATCH; revoke is irreversible and gated behind an inline confirm. A link
 * to the OGIAM decision explorer is the bridge from WHO (this profile) to WHAT
 * (the gated actions this agent has taken).
 *
 * Auth: every fetch goes through fetchWithRefresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithRefresh, jsonHeaders, getInstinctUser } from "@/lib/client-auth";
import ApprovalList from "@/components/agents/ApprovalList";
import ApprovalHistory from "@/components/agents/ApprovalHistory";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  Sparkline,
  ConsoleGrid,
} from "@/components/console";

type AgentState = "invited" | "active" | "paused" | "revoked";

interface AgentRecord {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  ownerUserId: string | null;
  state: AgentState;
  identityProvider: string;
  externalSubject: string | null;
  scanStatus: "pending" | "complete";
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface AgentResponse {
  agent: AgentRecord;
}

/* The self-onboarding scan: the system model the agent learned the first time
   it logged in and introspected its own toolset. The scan is agent-initiated,
   so it is absent (404 no_scan) until the agent has actually run it. */
interface ScanTool {
  name: string;
  description: string;
  capability: string;
  isMutation: boolean;
  allowed: boolean;
}

interface ScanModel {
  capabilities: string[];
  tools: ScanTool[];
  summary: {
    toolCount: number;
    allowedToolCount: number;
    mutationCount: number;
    capabilityCount: number;
  };
}

interface ScanRecord {
  id: string;
  agentId: string;
  workspaceId: string;
  scanVersion: string | number;
  toolCount: number;
  allowedToolCount: number;
  capabilityCount: number;
  createdAt: string;
  model: ScanModel;
}

interface ScanResponse {
  scan: ScanRecord;
}

/* Assigned work: a human assigns a goal to the agent; the agent runtime (not
   this UI) executes it as governed steps. A numbered list in the goal becomes
   multiple steps. Each step records the tool it tried and a gate outcome, so a
   "blocked" step is the OGIAM gate stopping the agent and asking the owner to
   approve, which is the governance working as intended. */
type TaskStatus = "queued" | "running" | "succeeded" | "blocked" | "failed";
type StepOutcome = "ran" | "blocked" | "no_match" | "error";

interface AgentTaskStep {
  index: number;
  instruction: string;
  tool: string | null;
  outcome: StepOutcome;
  detail: string | null;
  /** Workspace-internal URL of a visual artifact (e.g. a captured screenshot). */
  imageUrl?: string | null;
}

interface AgentTask {
  id: string;
  agentId: string;
  workspaceId: string;
  assignedBy: string | null;
  goal: string;
  status: TaskStatus;
  steps: AgentTaskStep[];
  resultSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface TasksResponse {
  tasks: AgentTask[];
}

interface RunTasksResponse {
  ran: number;
  tasks: AgentTask[];
}

/* Terminal vs in-flight. A task is terminal once the runtime has finished
   governing it (every step ran, a step was blocked by the gate, or it errored).
   queued and running are in-flight: the agent has work left to do, so the UI
   polls until nothing is in-flight (or a poll cap is hit). */
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "blocked",
  "failed",
]);

function isTerminalTask(task: AgentTask): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

function hasInFlightTask(tasks: AgentTask[]): boolean {
  return tasks.some((t) => !isTerminalTask(t));
}

function hasQueuedTask(tasks: AgentTask[]): boolean {
  return tasks.some((t) => t.status === "queued");
}

/* Cap the live poll so a stuck task (runtime never finishes it) can never spin
   an interval forever. At 3s a poll this is one minute of watching. */
const MAX_TASK_POLLS = 20;
const TASK_POLL_INTERVAL_MS = 3000;

/* Behavior + drift: the gate keeps an agent in check across model changes by
   comparing its recent behavior to a captured baseline. A behavior shift past
   the threshold raises the drift score and, when critical, auto-pauses the
   agent for owner review. The baseline is the agent's "normal" snapshot; drift
   events are each check's verdict over time. */
type DriftVerdict = "stable" | "drifting" | "critical" | "insufficient_data";
type DriftActionTaken = "none" | "paused";

interface DriftBaseline {
  metrics: {
    count: number;
    blockRate: number;
    tierDist: Record<string, number>;
    outcomeDist: Record<string, number>;
    toolDist: Record<string, number>;
  };
  decisionCount: number;
  capturedAt: string;
}

interface DriftEvent {
  id: string;
  agentId: string;
  driftScore: number;
  verdict: DriftVerdict;
  action: DriftActionTaken;
  createdAt: string;
}

interface DriftResponse {
  baseline: DriftBaseline | null;
  events: DriftEvent[];
  latest: DriftEvent | null;
}

/* The baseline POST returns { baseline } (201) and the drift-check POST returns
   { result: { verdict, score, action } } (200). We do not read either body: the
   set-baseline and check-drift handlers refetch the drift view (and, for a
   check, the agent) so the canonical GET drives the UI rather than the POST
   echo. The contract is documented on the route handlers. */

/* Drift load is independent of the agent load: a failure collapses to a quiet
   error state so the section never blanks the page. A null baseline with no
   events is the expected steady state for a freshly onboarded agent. */
type DriftState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; baseline: DriftBaseline | null; events: DriftEvent[]; latest: DriftEvent | null };

/* Agent log: the IAM auditing pillar. A TRUE granular audit trail of every
   governed action this agent took, straight from the richer agent-log endpoint.
   Each entry is the full trail from prompt to response: the redacted input, the
   governance decision, the redacted tool result, the acting identity, and the
   tamper-evident hash chain. The same ledger feeds drift detection and
   procedure learning, so nothing the agent does is lost: it is recorded once
   and consumed for audit, drift, and learning alike. Loads independently of the
   agent so a log failure never blanks the profile; an empty list is the
   expected steady state for a freshly onboarded agent that has not acted yet. */
interface AgentLogOutcome {
  ok: boolean;
  code: string | null;
  result_redacted: unknown;
  duration_ms: number | null;
}

interface AgentLogEntry {
  id: string;
  seq: number;
  created_at: string;
  tool: string;
  capability: string;
  surface: string | null;
  risk_tier: string;
  intended_outcome: string;
  effective_outcome: string;
  would_block: boolean;
  rule_id: string | null;
  reason: string | null;
  policy_version: string | null;
  on_behalf_user_id: string | null;
  on_behalf_role: string | null;
  redacted_params: unknown;
  signals: Record<string, unknown> | null;
  params_hash: string | null;
  entry_hash: string | null;
  outcome: AgentLogOutcome | null;
}

interface AgentLogResponse {
  entries: AgentLogEntry[];
}

/* Cap the visible ledger so a chatty agent can never render thousands of rows
   into the page; the GET already requests at most this many, newest first. */
const MAX_LOG_ROWS = 50;

type LogState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; entries: AgentLogEntry[] };

/* Connected systems (Access): a binding ties a client platform to THIS agent,
   making it "a Salesforce agent", "a Jira agent", etc. The GET returns the
   connections BOUND to this agent (the systems it operates) plus the workspace
   connections AVAILABLE to bind but not yet attached. The masked shape never
   returns a password; a username_password connection is one the operator wired
   with the login (username + password) they themselves use on the client's
   system, so the agent can run an authenticated scan of it. Loads independently
   of the agent so a connections failure never blanks the profile; an empty
   bound list is the expected steady state for an agent with nothing connected
   yet. */
interface AgentConnection {
  connectorName: string;
  baseUrl: string;
  authType: string;
}

interface AgentConnectionsResponse {
  bound: AgentConnection[];
  available: AgentConnection[];
}

type ConnectionsState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; bound: AgentConnection[]; available: AgentConnection[] };

interface TaskResponse {
  task: AgentTask;
}

type TasksState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; tasks: AgentTask[] };

/* Shared styling for the task-template inputs so the objective, success
   criteria, context, and target fields read as one form. */
const TASK_FIELD_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.6rem 0.7rem",
  background: "var(--wp-dark-surface2, #1a1a1a)",
  color: "var(--wp-text, #eee)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: "6px",
  fontSize: "0.85rem",
  fontFamily: "inherit",
  resize: "vertical",
};
const TASK_LABEL_STYLE: CSSProperties = {
  display: "block",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--wp-text, #eee)",
  marginBottom: "0.3rem",
};

/* Scan load is independent of the agent load: a missing scan (404 no_scan) is
   the expected steady state for a freshly onboarded agent, not an error. */
type ScanState =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "error" }
  | { kind: "present"; scan: ScanRecord };

type LifecycleAction = "pause" | "resume" | "revoke";

/* The four content groups of the profile, surfaced as tabs so only one shows at
   a time and the page no longer scrolls through every section stacked. The exact
   grouping: Overview (identity + system model), Work (assigned work + pending
   writes), Access (connected systems + backup), Activity (drift + agent log).
   Every section lands in exactly one tab and every panel stays mounted. */
type TabKey = "overview" | "work" | "access" | "activity";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "work", label: "Work" },
  { key: "access", label: "Access" },
  { key: "activity", label: "Activity" },
];

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
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

function taskStatusColor(status: TaskStatus): { fg: string; bg: string } {
  switch (status) {
    case "running":
      return { fg: "var(--wp-info, #3b82f6)", bg: "rgba(59,130,246,0.12)" };
    case "succeeded":
      return { fg: "var(--wp-success, #22c55e)", bg: "rgba(34,197,94,0.12)" };
    case "blocked":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    case "failed":
      return { fg: "var(--wp-error, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

function stepOutcomeColor(outcome: StepOutcome): { fg: string; bg: string } {
  switch (outcome) {
    case "ran":
      return { fg: "var(--wp-success, #22c55e)", bg: "rgba(34,197,94,0.12)" };
    case "blocked":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    case "error":
      return { fg: "var(--wp-error, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

function driftVerdictColor(verdict: DriftVerdict): { fg: string; bg: string } {
  switch (verdict) {
    case "stable":
      return { fg: "var(--wp-success, #22c55e)", bg: "rgba(34,197,94,0.12)" };
    case "drifting":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    case "critical":
      return { fg: "var(--wp-error, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

/* The OGIAM decision-outcome palette, matched to the hexes already used across
   the gate's decision surfaces: allow green, deny red, escalate amber,
   transform blue, and monitor / anything-else grey. These are the documented
   outcome colors, not free-form picks. */
function outcomeColor(outcome: string): { fg: string; bg: string } {
  switch (outcome) {
    case "allow":
      return { fg: "#22A55C", bg: "rgba(34,165,92,0.12)" };
    case "deny":
      return { fg: "#FF5F57", bg: "rgba(255,95,87,0.12)" };
    case "escalate":
      return { fg: "#E8B528", bg: "rgba(232,181,40,0.12)" };
    case "transform":
      return { fg: "#6FA8DC", bg: "rgba(111,168,220,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

function Field({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ fontSize: "0.9rem", color: "var(--wp-text, #eee)", wordBreak: "break-word" }}
      >
        {value}
      </span>
    </div>
  );
}

function TaskRow({ task }: { task: AgentTask }) {
  const [expanded, setExpanded] = useState(false);
  const c = taskStatusColor(task.status);
  return (
    <li
      data-testid={`agent-task-${task.id}`}
      style={{
        listStyle: "none",
        padding: "0.7rem 0.8rem",
        marginBottom: "0.5rem",
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span
          data-testid={`agent-task-status-${task.id}`}
          style={{
            flexShrink: 0,
            padding: "0.1rem 0.5rem",
            borderRadius: "10px",
            fontSize: "0.68rem",
            fontWeight: 600,
            textTransform: "capitalize",
            background: c.bg,
            color: c.fg,
            border: `1px solid ${c.fg}`,
          }}
        >
          {task.status}
        </span>
        <span
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: "0.88rem",
            color: "var(--wp-text, #eee)",
            /* Wrap long goals instead of clipping with an ellipsis: a long
               instruction (e.g. a web-search request) was getting cut off so the
               manager could not read what was assigned. */
            overflowWrap: "anywhere",
            whiteSpace: "normal",
          }}
          title={task.goal}
        >
          {task.goal}
        </span>
        <span style={{ flexShrink: 0, fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}>
          {relativeTime(task.createdAt)}
        </span>
      </div>

      {task.resultSummary && (
        <div
          data-testid={`agent-task-result-${task.id}`}
          style={{ marginTop: "0.35rem", fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)", lineHeight: 1.4 }}
        >
          {task.resultSummary}
        </div>
      )}

      {task.steps.length > 0 && (
        <button
          type="button"
          data-testid={`agent-task-toggle-${task.id}`}
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: "0.45rem",
            padding: 0,
            background: "transparent",
            color: "var(--wp-gold, #f1c233)",
            border: "none",
            fontSize: "0.74rem",
            cursor: "pointer",
          }}
        >
          {expanded ? "Hide" : "Show"} {task.steps.length} governed step
          {task.steps.length === 1 ? "" : "s"}
        </button>
      )}

      {expanded && task.steps.length > 0 && (
        <ul
          data-testid={`agent-task-steps-${task.id}`}
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0.5rem 0 0 0",
            maxHeight: "200px",
            overflowY: "auto",
          }}
        >
          {task.steps.map((step) => {
            const oc = stepOutcomeColor(step.outcome);
            return (
              <li
                key={step.index}
                data-testid={`agent-task-${task.id}-step-${step.index}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.5rem",
                  padding: "0.4rem 0.5rem",
                  marginBottom: "0.3rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              >
                <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: "0.8rem", color: "var(--wp-text, #eee)", lineHeight: 1.4 }}>
                  <span style={{ display: "block" }}>{step.instruction}</span>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--wp-text-muted, #6b7280)",
                      fontFamily: "var(--wp-mono, monospace)",
                    }}
                  >
                    {step.tool ?? "no tool"}
                  </span>
                  {step.detail ? (
                    <span
                      data-testid={`agent-task-${task.id}-step-${step.index}-detail`}
                      style={{
                        display: "block",
                        marginTop: "0.2rem",
                        fontSize: "0.72rem",
                        lineHeight: 1.4,
                        color: step.outcome === "error" || step.outcome === "blocked"
                          ? "var(--wp-danger, #f08a8a)"
                          : "var(--wp-text-muted, #9ca3af)",
                      }}
                    >
                      {step.detail}
                    </span>
                  ) : null}
                  {step.imageUrl ? (
                    <a
                      href={step.imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`agent-task-${task.id}-step-${step.index}-screenshot`}
                      style={{ display: "block", marginTop: "0.35rem" }}
                    >
                      <img
                        src={step.imageUrl}
                        alt="Captured screenshot"
                        style={{
                          maxWidth: "260px",
                          width: "100%",
                          height: "auto",
                          borderRadius: "6px",
                          border: "1px solid var(--wp-dark-border, #333)",
                        }}
                      />
                    </a>
                  ) : null}
                </span>
                <span
                  data-testid={`agent-task-${task.id}-step-${step.index}-outcome`}
                  style={{
                    flexShrink: 0,
                    padding: "0.05rem 0.4rem",
                    borderRadius: "8px",
                    fontSize: "0.65rem",
                    fontWeight: 600,
                    background: oc.bg,
                    color: oc.fg,
                    border: `1px solid ${oc.fg}`,
                  }}
                >
                  {step.outcome}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/* Pretty-prints a redacted value for the audit drill-down. An object (or array)
   is JSON-formatted so the structure reads cleanly; a string is shown verbatim;
   null / undefined collapses to an em-free placeholder. This is the redacted
   payload the gate captured, never the raw secret-bearing input. */
function formatRedacted(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* The signal flags the gate raised on the input (PII, secret, injection, ...).
   A flag counts as raised when it is boolean true or a non-empty value, so an
   all-false / empty signals object surfaces no chips. Returns the raised flag
   names so the row can render one warning chip each. */
function raisedSignals(signals: Record<string, unknown> | null): string[] {
  if (!signals) return [];
  return Object.entries(signals)
    .filter(([, v]) => {
      if (v === true) return true;
      if (typeof v === "number") return v > 0;
      if (typeof v === "string") return v.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      return false;
    })
    .map(([k]) => k);
}

/* Truncates a hash to a head/tail proof string; the full value rides on the
   title so the chain is verifiable on hover without crowding the row. */
function shortHash(hash: string | null): string {
  if (!hash) return "(none)";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

const GROUP_LABEL_STYLE = {
  fontFamily: "var(--wp-mono, monospace)",
  fontSize: "10px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--wp-text-muted, #6b7280)",
  marginBottom: "0.35rem",
} as const;

const GROUP_STYLE = {
  marginTop: "0.7rem",
  padding: "0.6rem 0.7rem",
  background: "var(--wp-dark-surface, #1f1f22)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: "6px",
} as const;

const DETAIL_TEXT_STYLE = {
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--wp-text, #eee)",
  wordBreak: "break-word",
} as const;

const MONO_VALUE_STYLE = {
  fontFamily: "var(--wp-mono, monospace)",
  fontSize: "0.74rem",
  color: "var(--wp-text-dim, #aaa)",
  wordBreak: "break-all",
} as const;

/* One row of the agent's decision ledger, now a clickable audit entry. The
   compact summary stays one line (outcome pill, tool + capability mono, rule,
   risk tier, relative time); clicking it toggles a detail panel that walks the
   FULL trail from prompt to response: the redacted input, the governance
   decision, the redacted tool result, the acting identity, and the
   tamper-evident hash chain. Accessible: the summary is a button carrying
   aria-expanded. */
function LogRow({ entry }: { entry: AgentLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const oc = outcomeColor(entry.effective_outcome);
  const signals = raisedSignals(entry.signals);
  const detailId = `agent-log-detail-${entry.id}`;
  return (
    <li
      data-testid={`agent-log-row-${entry.id}`}
      style={{
        listStyle: "none",
        padding: "0.5rem 0.6rem",
        marginBottom: "0.3rem",
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "6px",
      }}
    >
      <button
        type="button"
        data-testid={`agent-log-row-${entry.id}-toggle`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={detailId}
        title={entry.reason ?? undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
          width: "100%",
          padding: 0,
          background: "transparent",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <span
          aria-hidden="true"
          style={{ flexShrink: 0, fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)", width: "0.8rem" }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        <span
          data-testid={`agent-log-row-${entry.id}-outcome`}
          style={{
            flexShrink: 0,
            padding: "0.05rem 0.4rem",
            borderRadius: "8px",
            fontSize: "0.65rem",
            fontWeight: 600,
            textTransform: "capitalize",
            background: oc.bg,
            color: oc.fg,
            border: `1px solid ${oc.fg}`,
          }}
        >
          {entry.effective_outcome}
        </span>
        <span
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: "0.8rem",
            color: "var(--wp-text-muted, #6b7280)",
            fontFamily: "var(--wp-mono, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.tool}
          {entry.capability ? ` · ${entry.capability}` : ""}
        </span>
        <span
          data-testid={`agent-log-row-${entry.id}-rule`}
          style={{
            flexShrink: 0,
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            fontFamily: "var(--wp-mono, monospace)",
          }}
        >
          {entry.rule_id ?? "no rule"}
        </span>
        <span
          style={{
            flexShrink: 0,
            padding: "0.05rem 0.4rem",
            borderRadius: "8px",
            fontSize: "0.65rem",
            background: "rgba(160,160,160,0.10)",
            color: "var(--wp-text-muted, #6b7280)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        >
          {entry.risk_tier}
        </span>
        <span style={{ flexShrink: 0, fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}>
          {relativeTime(entry.created_at)}
        </span>
      </button>

      {expanded && (
        <div
          id={detailId}
          data-testid={detailId}
          style={{ marginTop: "0.3rem" }}
        >
          {/* INPUT: the prompt the agent sent the tool, as the gate redacted it. */}
          <div data-testid={`agent-log-detail-${entry.id}-input`} style={GROUP_STYLE}>
            <div style={GROUP_LABEL_STYLE}>Input</div>
            <pre
              style={{
                ...DETAIL_TEXT_STYLE,
                fontFamily: "var(--wp-mono, monospace)",
                fontSize: "0.74rem",
                margin: 0,
                whiteSpace: "pre-wrap",
                maxHeight: "180px",
                overflowY: "auto",
              }}
            >
              {formatRedacted(entry.redacted_params)}
            </pre>
            <div style={{ marginTop: "0.35rem", fontSize: "0.68rem", color: "var(--wp-text-muted, #6b7280)" }}>
              This is the redacted prompt: secret-bearing values are stripped at the gate before capture.
            </div>
            {signals.length > 0 && (
              <div
                data-testid={`agent-log-detail-${entry.id}-signals`}
                style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.4rem" }}
              >
                {signals.map((s) => (
                  <span
                    key={s}
                    data-testid={`agent-log-detail-${entry.id}-signal-${s}`}
                    style={{
                      padding: "0.05rem 0.4rem",
                      borderRadius: "8px",
                      fontSize: "0.62rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.03em",
                      background: "rgba(232,181,40,0.12)",
                      color: "#E8B528",
                      border: "1px solid #E8B528",
                    }}
                  >
                    {s.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* GOVERNANCE: how the gate decided, intended vs effective. */}
          <div data-testid={`agent-log-detail-${entry.id}-governance`} style={GROUP_STYLE}>
            <div style={GROUP_LABEL_STYLE}>Governance</div>
            <div style={DETAIL_TEXT_STYLE}>
              <span style={{ fontFamily: "var(--wp-mono, monospace)", textTransform: "capitalize" }}>
                {entry.intended_outcome}
              </span>
              {" → "}
              <span style={{ fontFamily: "var(--wp-mono, monospace)", color: oc.fg, textTransform: "capitalize" }}>
                {entry.effective_outcome}
              </span>
            </div>
            <div style={{ marginTop: "0.3rem", ...MONO_VALUE_STYLE }}>
              rule {entry.rule_id ?? "(none)"} · risk {entry.risk_tier} · policy {entry.policy_version ?? "(none)"} · would block {entry.would_block ? "yes" : "no"}
            </div>
            {entry.reason ? (
              <div
                data-testid={`agent-log-detail-${entry.id}-reason`}
                style={{ marginTop: "0.3rem", fontSize: "0.74rem", lineHeight: 1.4, color: "var(--wp-text-muted, #6b7280)" }}
              >
                {entry.reason}
              </div>
            ) : null}
          </div>

          {/* RESPONSE: the redacted tool result, or a note for older actions. */}
          <div data-testid={`agent-log-detail-${entry.id}-response`} style={GROUP_STYLE}>
            <div style={GROUP_LABEL_STYLE}>Response</div>
            {entry.outcome ? (
              <>
                <div style={DETAIL_TEXT_STYLE}>
                  <span style={{ fontWeight: 600, color: entry.outcome.ok ? "#22A55C" : "#FF5F57" }}>
                    {entry.outcome.ok ? "Succeeded" : "Failed"}
                  </span>
                  {" · "}
                  <span style={{ fontFamily: "var(--wp-mono, monospace)" }}>
                    {entry.outcome.code ?? "no code"}
                  </span>
                  {entry.outcome.duration_ms !== null ? ` · ${entry.outcome.duration_ms}ms` : ""}
                </div>
                <pre
                  style={{
                    ...DETAIL_TEXT_STYLE,
                    fontFamily: "var(--wp-mono, monospace)",
                    fontSize: "0.74rem",
                    margin: "0.35rem 0 0 0",
                    whiteSpace: "pre-wrap",
                    maxHeight: "180px",
                    overflowY: "auto",
                  }}
                >
                  {formatRedacted(entry.outcome.result_redacted)}
                </pre>
              </>
            ) : (
              <div
                data-testid={`agent-log-detail-${entry.id}-no-response`}
                style={{ fontSize: "0.76rem", color: "var(--wp-text-muted, #6b7280)" }}
              >
                No recorded result for this action.
              </div>
            )}
          </div>

          {/* IDENTITY: who the agent acted on behalf of, and where. */}
          <div data-testid={`agent-log-detail-${entry.id}-identity`} style={GROUP_STYLE}>
            <div style={GROUP_LABEL_STYLE}>Identity</div>
            <div style={MONO_VALUE_STYLE}>
              on behalf of {entry.on_behalf_user_id ?? "(none)"} · role {entry.on_behalf_role ?? "(none)"} · surface {entry.surface ?? "(none)"}
            </div>
          </div>

          {/* INTEGRITY: the tamper-evident chain proof for this entry. */}
          <div data-testid={`agent-log-detail-${entry.id}-integrity`} style={GROUP_STYLE}>
            <div style={GROUP_LABEL_STYLE}>Integrity</div>
            <div style={MONO_VALUE_STYLE}>
              <div>seq {entry.seq}</div>
              <div title={entry.params_hash ?? undefined}>params {shortHash(entry.params_hash)}</div>
              <div title={entry.entry_hash ?? undefined}>entry {shortHash(entry.entry_hash)}</div>
            </div>
            <div style={{ marginTop: "0.3rem", fontSize: "0.68rem", color: "var(--wp-text-muted, #6b7280)" }}>
              The hash chain makes this record tamper-evident: each entry seals the one before it.
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export default function AgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  /* Tabbed layout. Every panel stays mounted (inactive ones hidden with CSS, not
     unmounted) so all loaders/polling keep running and every section's testids
     remain queryable; only the active tab is visible. Defaults to Overview. */
  const [tab, setTab] = useState<TabKey>("overview");
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  /* Fire-once guard for the "command view viewed" engagement event: the agent
     can be refetched (lifecycle PATCH, drift-check), so a ref keeps the view
     event to a single emission per mount. Never set before the auth guard
     passes, so a logged-out visitor emits nothing. */
  const commandViewViewedRef = useRef(false);
  const [scan, setScan] = useState<ScanState>({ kind: "loading" });
  /* Manager-triggered self-onboarding scan. The scan is normally agent-initiated;
     this control lets a manager kick it from the dashboard and watch the System
     model populate. Busy disables the button while the POST is in flight; the
     error is a quiet inline message (e.g. 409 = agent must be active) that never
     blanks the section. */
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Set when revoke is armed: revoke is irreversible, so the first click arms
     an inline confirm and the second click performs the PATCH. */
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  /* Assigned work. Tasks load independently of the agent so a tasks failure
     never blanks the profile. The assign form POSTs a goal and prepends the
     returned task; revoked agents (409) and validation (400) surface inline. */
  const [tasks, setTasks] = useState<TasksState>({ kind: "loading" });
  // The task template. `goal` holds the Objective (maps to the task goal / the
  // plan); the rest are the structured template fields.
  const [goal, setGoal] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [taskContext, setTaskContext] = useState("");
  const [targetConnectionId, setTargetConnectionId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  /* Run-queued control: drains tasks already sitting in "queued" (e.g. ones
     created before execution was wired up) via the run endpoint, then refreshes
     the list with the returned, now-executed tasks. */
  const [runningQueued, setRunningQueued] = useState(false);

  /* Behavior + drift. Loads independently of the agent so a drift failure never
     blanks the profile. The two controls (set baseline, check drift now) POST
     and then refetch the drift view; a drift check also refetches the agent so
     an auto-pause reflects in the lifecycle state chip. */
  const [drift, setDrift] = useState<DriftState>({ kind: "loading" });
  const [driftBusy, setDriftBusy] = useState(false);

  /* Agent log: the OGIAM decision ledger for this agent. Loads independently of
     the agent so a log failure never blanks the profile; an empty list is a
     first-class "no governed actions yet" state, not an error. The Refresh
     control re-runs loadLog (which re-fires the analytics view event). */
  const [log, setLog] = useState<LogState>({ kind: "loading" });
  const [logBusy, setLogBusy] = useState(false);

  /* Connected systems (Access). Loads independently of the agent so a
     connections failure never blanks the profile; an empty bound list is a
     first-class "nothing connected yet" state, not an error. The add form
     creates a NEW connection (POST /api/admin/connectors) and binds it to this
     agent in one action; the bind-existing control attaches a workspace
     connection already created elsewhere. */
  const [connections, setConnections] = useState<ConnectionsState>({ kind: "loading" });
  /* The connector chosen in the bind-existing select, and the in-flight flag
     shared by both the bind-existing and unbind actions. */
  const [bindSelection, setBindSelection] = useState("");
  const [binding, setBinding] = useState(false);
  const [connName, setConnName] = useState("");
  const [connBaseUrl, setConnBaseUrl] = useState("");
  const [connLoginPath, setConnLoginPath] = useState("/api/auth/login");
  const [connUsername, setConnUsername] = useState("");
  const [connPassword, setConnPassword] = useState("");
  const [connSessionCookie, setConnSessionCookie] = useState("session");
  /* The connection auth type. "username_password" is a client form login (the
     default); "oauth_password" wires an OAuth Resource-Owner-Password provider
     (e.g. a Salesforce sandbox) where baseUrl is the login host and loginPath
     the token path. */
  const [connAuthType, setConnAuthType] = useState<"username_password" | "oauth_password">("username_password");
  const [connClientId, setConnClientId] = useState("");
  const [connClientSecret, setConnClientSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  /* Backup agent (failover for uptime). This agent can designate a backup; when
     it goes unhealthy (paused/revoked) its queued work fails over to the backup,
     which runs it under the SAME OGIAM gate and scope. The select is populated
     from the OTHER agents in the workspace; saving POSTs the backup endpoint.
     Loads independently so a failure never blanks the profile. */
  const [backupAgentId, setBackupAgentId] = useState<string | null>(null);
  const [backupOptions, setBackupOptions] = useState<{ id: string; name: string }[]>([]);
  const [backupSelection, setBackupSelection] = useState<string>("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        setAgent(null);
        return;
      }
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to view this agent.");
        } else {
          setError(`Could not load agent (HTTP ${res.status}).`);
        }
        setAgent(null);
        return;
      }
      const body = (await res.json()) as AgentResponse;
      setAgent(body.agent ?? null);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  /* Fetches the agent's self-onboarding scan. A 404 (no_scan) is a first-class
     state, not an error: the scan is agent-initiated and absent until the agent
     logs in and introspects. Any other failure collapses to a quiet error state
     so the section never blanks the page. */
  const loadScan = useCallback(async () => {
    setScan({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/scan`);
      if (res.status === 404) {
        setScan({ kind: "absent" });
        return;
      }
      if (!res.ok) {
        setScan({ kind: "error" });
        return;
      }
      const body = (await res.json()) as ScanResponse;
      if (body.scan) {
        setScan({ kind: "present", scan: body.scan });
      } else {
        setScan({ kind: "absent" });
      }
    } catch {
      setScan({ kind: "error" });
    }
  }, [id]);

  /* Loads the agent's assigned work. A failure collapses to a quiet error state
     so the section never blanks the page; an empty array is a first-class
     "no work yet" state, not an error. */
  const loadTasks = useCallback(async () => {
    setTasks({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/tasks`);
      if (!res.ok) {
        setTasks({ kind: "error" });
        return;
      }
      const body = (await res.json()) as TasksResponse;
      setTasks({ kind: "present", tasks: body.tasks ?? [] });
    } catch {
      setTasks({ kind: "error" });
    }
  }, [id]);

  /* Loads the agent's behavior baseline + drift history. A failure collapses to
     a quiet error state so the section never blanks the page; a null baseline
     with no events is a first-class "no baseline yet" state, not an error. */
  const loadDrift = useCallback(async () => {
    setDrift({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/drift`);
      if (!res.ok) {
        setDrift({ kind: "error" });
        return;
      }
      const body = (await res.json()) as DriftResponse;
      setDrift({
        kind: "present",
        baseline: body.baseline ?? null,
        events: body.events ?? [],
        latest: body.latest ?? null,
      });
    } catch {
      setDrift({ kind: "error" });
    }
  }, [id]);

  /* Loads the agent's OGIAM decision ledger (the IAM audit trail) newest-first,
     capped by the GET. On success we fire ONE analytics event ("agent.log_viewed",
     already in the InstinctEventType union) carrying the decision count: a review
     is itself a learning signal, the same ledger the drift detector and
     procedure-learning loop consume. The analytics POST is best effort: a
     failure must never break the section, so it is fire-and-forget. A fetch
     failure collapses to a quiet error state so the section never blanks. */
  const loadLog = useCallback(async () => {
    setLog({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/log?limit=50`);
      if (!res.ok) {
        setLog({ kind: "error" });
        return;
      }
      const body = (await res.json()) as AgentLogResponse;
      const entries = body.entries ?? [];
      setLog({ kind: "present", entries });
      /* Best effort: the IAM review is recorded once, consumed for learning. An
         analytics failure must not break the log section, so we swallow it. The
         decision_count carries the rendered entry total (same event name). */
      void fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          event: "agent.log_viewed",
          metadata: { agent_id: id, decision_count: entries.length },
        }),
      }).catch(() => undefined);
    } catch {
      setLog({ kind: "error" });
    }
  }, [id]);

  /* Loads the systems BOUND to this agent (the ones it operates) plus the
     workspace connections AVAILABLE to bind. A failure collapses to a quiet
     error state so the section never blanks the page; an empty bound list is a
     first-class "nothing connected yet" state, not an error. The GET is masked:
     it never returns a connection's password. Scoped to this agent, not the
     whole workspace, so the section reflects what makes it a Salesforce / Jira /
     ... agent. */
  const loadConnections = useCallback(async () => {
    setConnections({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/connections`);
      if (!res.ok) {
        setConnections({ kind: "error" });
        return;
      }
      const body = (await res.json()) as AgentConnectionsResponse;
      setConnections({
        kind: "present",
        bound: body.bound ?? [],
        available: body.available ?? [],
      });
    } catch {
      setConnections({ kind: "error" });
    }
  }, [id]);

  /* Loads this agent's designated backup plus the roster of OTHER agents that
     can serve as a backup. The backup select is populated from the roster minus
     THIS agent. A failure collapses to a quiet state (no options, no current
     backup) so the section never blanks the page. */
  const loadBackup = useCallback(async () => {
    setBackupError(null);
    try {
      const [backupRes, rosterRes] = await Promise.all([
        fetchWithRefresh(`/api/admin/agents/${id}/backup`),
        fetchWithRefresh(`/api/admin/agents`),
      ]);
      if (backupRes.ok) {
        const b = (await backupRes.json()) as { backupAgentId?: string | null };
        const current = b.backupAgentId ?? null;
        setBackupAgentId(current);
        setBackupSelection(current ?? "");
      }
      if (rosterRes.ok) {
        const r = (await rosterRes.json()) as { agents?: { id: string; name: string }[] };
        const others = (r.agents ?? [])
          .filter((a) => a.id !== id)
          .map((a) => ({ id: a.id, name: a.name }));
        setBackupOptions(others);
      }
    } catch {
      /* Quiet: a backup-load failure must never blank the profile. */
    }
  }, [id]);

  useEffect(() => {
    /* Redirect unauthenticated users; never render a blank state. A missing
       session would otherwise let every authenticated fetch 401 and paint an
       empty command view (the April-16 blank-dashboard class of bug). */
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push(`/login?next=/admin/agents/${id}`);
      return;
    }
    void load();
    // load is stable (useCallback keyed on id); router/id are read, not deps, to
    // avoid re-running the guard on every render (the mock returns a fresh router
    // object each render, which would otherwise re-trigger the load loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    void loadScan();
  }, [loadScan]);

  useEffect(() => {
    void loadBackup();
  }, [loadBackup]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void loadDrift();
  }, [loadDrift]);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  /* Live progress polling. While any task is in-flight (queued or running) we
     poll the tasks GET every few seconds and replace the list with the fresh
     one, so a manager watches the agent execute in real time. The poll stops as
     soon as every task is terminal, or after a sane cap so a stuck task can
     never spin the interval forever. A single interval, cleaned up on unmount
     and whenever polling should stop. The effect is keyed on whether the list
     currently has an in-flight task so it (re)arms when assigning new work and
     tears down once everything settles. */
  const tasksInFlight = tasks.kind === "present" && hasInFlightTask(tasks.tasks);

  /* Command-view metrics: derived purely from the data the page already fetched
     (the decision ledger, the assigned-work list, the agent record). No new
     fetch, no new endpoint: the same data, surfaced as the hero numbers a
     client scans first. The decision activity series drives the sparkline; the
     ledger is capped at MAX_LOG_ROWS so the counts read "recent governed
     actions" rather than an unbounded lifetime total. */
  const metrics = useMemo(() => {
    const entries = log.kind === "present" ? log.entries : [];
    const decisions = entries.length;
    /* The gate's verdict per governed action: an allow is the effective outcome
       resolving to "allow"; everything else (deny / escalate / transform /
       monitor) is the gate intervening. */
    const allowed = entries.filter((e) => e.effective_outcome === "allow").length;
    const denied = decisions - allowed;
    /* Gate enforcement: the share of governed actions where the gate would have
       blocked the agent (the value of the control plane, made legible). */
    const enforced = entries.filter((e) => e.would_block).length;
    const enforcementPct = decisions > 0 ? Math.round((enforced / decisions) * 100) : 0;

    const taskList = tasks.kind === "present" ? tasks.tasks : [];
    const runs = taskList.length;

    /* Decision-activity sparkline: bucket the (newest-first) ledger into a
       coarse oldest-to-newest series so the trend reads left-to-right. A short
       ledger still produces a sensible flat/rising line via the Sparkline's own
       1-and-n-point handling. */
    const buckets = 12;
    const series: number[] = [];
    if (decisions > 0) {
      const chrono = [...entries].reverse();
      const size = Math.max(1, Math.ceil(chrono.length / buckets));
      for (let i = 0; i < chrono.length; i += size) {
        series.push(chrono.slice(i, i + size).length);
      }
    }

    return { decisions, allowed, denied, enforcementPct, runs, series };
  }, [log, tasks]);

  /* Fire the "command view viewed" engagement event ONCE, after a successful
     agent load. A view is itself a learning signal (the same ledger drift +
     procedure learning consume). The decision_count / run_count mirror the
     metric tiles (metrics.decisions / metrics.runs), defaulting to 0 when the
     log / tasks have not loaded yet. The ref keeps refetches (PATCH, drift
     check) from re-firing it; the analytics POST is best effort and never
     blanks the page. Guarded on agent presence so a logged-out visitor (no
     agent, redirected) emits nothing. */
  useEffect(() => {
    if (!agent || commandViewViewedRef.current) return;
    commandViewViewedRef.current = true;
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "agent.command_view_viewed",
        metadata: {
          agent_id: id,
          decision_count: metrics.decisions,
          run_count: metrics.runs,
        },
      }),
    }).catch(() => undefined);
  }, [agent, id, metrics.decisions, metrics.runs]);

  useEffect(() => {
    if (!tasksInFlight) return;
    let polls = 0;
    let cancelled = false;
    const interval = setInterval(() => {
      void (async () => {
        if (cancelled) return;
        polls += 1;
        try {
          const res = await fetchWithRefresh(`/api/admin/agents/${id}/tasks`);
          if (cancelled) return;
          if (res.ok) {
            const body = (await res.json()) as TasksResponse;
            const next = body.tasks ?? [];
            setTasks({ kind: "present", tasks: next });
            if (!hasInFlightTask(next)) {
              clearInterval(interval);
            }
          }
        } catch {
          /* A transient poll failure is non-fatal: keep the last good list and
             let the next tick (or the cap) resolve it. */
        }
        if (polls >= MAX_TASK_POLLS) clearInterval(interval);
      })();
    }, TASK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tasksInFlight, id]);

  async function runAction(action: LifecycleAction) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error || `Could not ${action} agent (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as AgentResponse;
      setAgent(body.agent ?? null);
      setConfirmingRevoke(false);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  /* Assigns a goal and watches it execute. The POST now returns the task already
     governed to a terminal status (succeeded / blocked / failed) with its steps
     populated, so we prepend it and the manager immediately sees what the agent
     did rather than a stuck "Queued". We also refetch the list so any task the
     agent executed out of band is reflected; if a task still reports in-flight,
     the poll effect picks it up. Clears the textarea on success; 400/404/409
     surface inline (409 = the agent must be active to run work). */
  async function assignTask() {
    const objective = goal.trim();
    const sc = successCriteria.trim();
    // Objective and Success criteria are the required template fields.
    if (!objective || !sc || assigning) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/tasks`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          objective,
          successCriteria: sc,
          context: taskContext.trim() || undefined,
          targetConnectionId: targetConnectionId || undefined,
          source: "detail_page",
        }),
      });
      if (res.status === 201 || res.ok) {
        const body = (await res.json()) as TaskResponse;
        if (body.task) {
          const created = body.task;
          setTasks((prev) => {
            const existing = prev.kind === "present" ? prev.tasks : [];
            return { kind: "present", tasks: [created, ...existing] };
          });
        }
        setGoal("");
        setSuccessCriteria("");
        setTaskContext("");
        setTargetConnectionId("");
        /* The returned task is already terminal (or, if the runtime is still
           draining it, queued/running), so prepending it is enough: a terminal
           task renders its real status and steps at once, and a still-in-flight
           one arms the live poll, which makes the list canonical without a
           redundant fetch here. */
        return;
      }
      if (res.status === 409) {
        setAssignError("This agent must be active to run work. Resume it first.");
      } else if (res.status === 404) {
        setAssignError("This agent no longer exists.");
      } else if (res.status === 400) {
        const b = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        setAssignError(b.detail || b.error || "That task is not valid. Complete the required fields and try again.");
      } else {
        setAssignError(`Could not assign work (HTTP ${res.status}).`);
      }
    } catch (e) {
      setAssignError((e as Error).message || "Network error");
    } finally {
      setAssigning(false);
    }
  }

  /* Drains tasks already sitting in "queued" by POSTing the run endpoint, then
     refreshes the list from the returned, now-executed tasks. This lets a
     manager kick off work that was queued before execution was wired up. The
     200 body carries the updated task list; we also fall back to loadTasks so
     the UI is canonical even if the body is shaped differently. */
  async function runQueuedWork() {
    if (runningQueued) return;
    setRunningQueued(true);
    setAssignError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/tasks/run`, {
        method: "POST",
        headers: jsonHeaders(),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as RunTasksResponse | null;
        if (body && Array.isArray(body.tasks)) {
          setTasks({ kind: "present", tasks: body.tasks });
        } else {
          await loadTasks();
        }
        return;
      }
      if (res.status === 409) {
        setAssignError("This agent must be active to run work. Resume it first.");
      } else if (res.status === 404) {
        setAssignError("This agent no longer exists.");
      } else {
        setAssignError(`Could not run queued work (HTTP ${res.status}).`);
      }
    } catch (e) {
      setAssignError((e as Error).message || "Network error");
    } finally {
      setRunningQueued(false);
    }
  }

  /* Captures a fresh baseline of the agent's normal behavior, then refetches the
     drift view so the new baseline (and any reset history) is reflected. */
  async function setBaseline() {
    if (driftBusy) return;
    setDriftBusy(true);
    try {
      await fetchWithRefresh(`/api/admin/agents/${id}/baseline`, {
        method: "POST",
        headers: jsonHeaders(),
      });
      await loadDrift();
    } catch {
      /* loadDrift surfaces the quiet error state; nothing more to do here. */
    } finally {
      setDriftBusy(false);
    }
  }

  /* Runs a drift check now. The gate may auto-pause the agent when the verdict
     is critical, so we refetch BOTH the drift view (for the new event/verdict)
     and the agent (so a pause shows in the lifecycle state chip). */
  async function checkDriftNow() {
    if (driftBusy) return;
    setDriftBusy(true);
    try {
      await fetchWithRefresh(`/api/admin/agents/${id}/drift-check`, {
        method: "POST",
        headers: jsonHeaders(),
      });
      await loadDrift();
      await load();
    } catch {
      /* loadDrift surfaces the quiet error state; nothing more to do here. */
    } finally {
      setDriftBusy(false);
    }
  }

  /* Re-fetches the agent log on demand (the Refresh control). Reuses the same
     busy/refresh pattern the other sections use; loadLog re-fires the view
     analytics event so a manual review is captured too. */
  async function refreshLog() {
    if (logBusy) return;
    setLogBusy(true);
    try {
      await loadLog();
    } finally {
      setLogBusy(false);
    }
  }

  /* Binds an existing workspace connection to THIS agent, making the agent
     operate that system. POSTs { connectorName } to the agent-connections
     endpoint; on success it reloads so the connection moves from "available"
     into the bound list. A failure surfaces inline without blanking. */
  async function bindExisting() {
    const name = bindSelection.trim();
    if (!name || binding) return;
    setBinding(true);
    setConnectionError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/connections`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ connectorName: name }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setConnectionError(b.error || `Could not connect that system (HTTP ${res.status}).`);
        return;
      }
      setBindSelection("");
      await loadConnections();
    } catch (e) {
      setConnectionError((e as Error).message || "Network error");
    } finally {
      setBinding(false);
    }
  }

  /* Unbinds a connection from this agent: the agent stops operating that system,
     but the workspace connection itself is left intact (it returns to the
     available list). DELETEs { connectorName } to the agent-connections
     endpoint, then reloads. A failure surfaces inline without blanking. */
  async function unbindConnection(connectorName: string) {
    if (binding) return;
    setBinding(true);
    setConnectionError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/connections`, {
        method: "DELETE",
        headers: jsonHeaders(),
        body: JSON.stringify({ connectorName }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setConnectionError(b.error || `Could not disconnect that system (HTTP ${res.status}).`);
        return;
      }
      await loadConnections();
    } catch (e) {
      setConnectionError((e as Error).message || "Network error");
    } finally {
      setBinding(false);
    }
  }

  /* Sets or clears this agent's backup. POSTs { backupAgentId } (null clears) to
     the backup endpoint; on success it updates the current backup chip. The
     server validates the backup is a different, existing, same-workspace,
     non-cyclic agent, so a 400/404 surfaces inline without blanking. */
  async function saveBackup() {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      const next = backupSelection.trim() === "" ? null : backupSelection.trim();
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/backup`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ backupAgentId: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 404) {
          setBackupError(b.error === "backup_not_found" ? "That backup agent no longer exists." : "This agent no longer exists.");
        } else if (b.error === "backup_is_self") {
          setBackupError("An agent cannot be its own backup. Pick a different agent.");
        } else if (b.error === "backup_cycle") {
          setBackupError("That would create a backup loop (it already backs up this agent). Pick a different agent.");
        } else if (b.error === "backup_cross_workspace") {
          setBackupError("The backup must be in the same workspace.");
        } else {
          setBackupError(b.error || `Could not save the backup (HTTP ${res.status}).`);
        }
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { backupAgentId?: string | null };
      setBackupAgentId(body.backupAgentId ?? next);
    } catch (e) {
      setBackupError((e as Error).message || "Network error");
    } finally {
      setBackupBusy(false);
    }
  }

  /* Connects this agent to a NEW client platform with the username + password
     the operator uses to sign in there (e.g. an account a client invited them
     to). "Add" is create + bind in one action: it POSTs the new connection to
     /api/admin/connectors, then POSTs { connectorName } to this agent's
     connections endpoint so the agent operates it. The password is encrypted
     server-side and never returned. On success we clear the password (it is
     never shown again) and reload the agent's bound list so the new connection
     appears with its "Run authenticated scan" link. A failure surfaces inline
     without blanking. */
  async function addConnection() {
    if (connecting) return;
    const name = connName.trim();
    const baseUrl = connBaseUrl.trim();
    const loginPath = connLoginPath.trim();
    const username = connUsername.trim();
    const sessionCookie = connSessionCookie.trim();
    const clientId = connClientId.trim();
    const clientSecret = connClientSecret.trim();
    if (connAuthType === "oauth_password") {
      if (!name || !baseUrl || !clientId || !clientSecret || !username || !connPassword || !loginPath) {
        setConnectionError("Fill in the system name, login URL, client id, client secret, username, password, and token path.");
        return;
      }
    } else if (!name || !baseUrl || !username || !connPassword || !loginPath) {
      setConnectionError("Fill in the system name, URL, username, password, and login path.");
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    try {
      const body =
        connAuthType === "oauth_password"
          ? {
              connectorName: name,
              baseUrl,
              authType: "oauth_password",
              clientId,
              clientSecret,
              username,
              password: connPassword,
              loginPath,
            }
          : {
              connectorName: name,
              baseUrl,
              authType: "username_password",
              username,
              password: connPassword,
              loginPath,
              ...(sessionCookie ? { sessionCookieName: sessionCookie } : {}),
            };
      const res = await fetchWithRefresh("/api/admin/connectors", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setConnectionError(b.error || `Could not connect that system (HTTP ${res.status}).`);
        return;
      }
      /* "Add" is create + bind: the connection now exists at the workspace level,
         so bind it to THIS agent in the same action. The bind POST carries just
         the connector name; its failure surfaces inline but the secrets are
         still cleared because the connection was created. */
      const bindRes = await fetchWithRefresh(`/api/admin/agents/${id}/connections`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ connectorName: name }),
      });
      if (!bindRes.ok) {
        const b = (await bindRes.json().catch(() => ({}))) as { error?: string };
        setConnectionError(b.error || `Created the connection but could not attach it to this agent (HTTP ${bindRes.status}).`);
      }
      /* The secrets are never shown again: clear the password (and client secret)
         on success and reload the agent's bound list so the new connection
         appears. */
      setConnPassword("");
      setConnClientSecret("");
      await loadConnections();
    } catch (e) {
      setConnectionError((e as Error).message || "Network error");
    } finally {
      setConnecting(false);
    }
  }

  /* Triggers the agent's self-onboarding scan. The agent introspects the platform
     and learns the tools it can use plus its capability ceiling. On 200 we refetch
     BOTH the scan (so the System model box renders the learned tools) and the agent
     (so SCAN STATUS flips to Complete). A 409 means the agent is paused or revoked
     and must be active to scan; other errors surface quietly without blanking. */
  async function runScan() {
    if (scanBusy) return;
    setScanBusy(true);
    setScanError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}/scan`, {
        method: "POST",
        headers: jsonHeaders(),
      });
      if (res.status === 409) {
        setScanError("This agent must be active to run an onboarding scan. Resume it first.");
        return;
      }
      if (res.status === 404) {
        setScanError("This agent no longer exists.");
        return;
      }
      if (!res.ok) {
        setScanError(`Could not run the onboarding scan (HTTP ${res.status}).`);
        return;
      }
      await loadScan();
      await load();
    } catch (e) {
      setScanError((e as Error).message || "Network error");
    } finally {
      setScanBusy(false);
    }
  }

  const wrap = {
    padding: "2rem 1.5rem",
    maxWidth: "760px",
    margin: "0 auto",
    color: "var(--wp-text, #eee)",
  } as const;

  /* A panel is the content for one tab. Inactive panels stay mounted but hidden
     with display:none so their loaders keep running and their testids stay
     queryable; only spacing differs. Constrained max-width for readability. */
  const panelStyle = (key: TabKey) =>
    ({
      display: tab === key ? "block" : "none",
      animation: tab === key ? "wpFadeIn 0.18s ease" : undefined,
    }) as const;

  const backLink = (
    <Link
      href="/admin/agents"
      data-testid="agent-back-link"
      style={{ fontSize: "0.82rem", color: "var(--wp-text-dim, #aaa)", textDecoration: "none" }}
    >
      &larr; All agents
    </Link>
  );

  if (loading) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div data-testid="agent-loading" style={{ marginTop: "1.5rem", color: "var(--wp-text-dim, #aaa)" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div
          data-testid="agent-not-found"
          style={{
            marginTop: "1.5rem",
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          No agent with id <code>{id}</code> was found. It may have been removed,
          or the id is wrong.
        </div>
      </div>
    );
  }

  if (error && !agent) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div
          data-testid="agent-error"
          style={{
            marginTop: "1.5rem",
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!agent) return <div data-testid="admin-agent-page" style={wrap}>{backLink}</div>;

  const isRevoked = agent.state === "revoked";

  return (
    <div data-testid="admin-agent-page" style={wrap}>
      {/* A subtle fade keeps tab switches smooth without any layout shift.
          The mobile rule degrades the lifecycle action row gracefully: on a
          narrow viewport (<= 480px) the pause/resume/revoke buttons go
          full-width and stack so they never overflow the right edge. Desktop
          is untouched (the buttons keep their natural width when there is
          room). */}
      <style>{"@keyframes wpFadeIn{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}@media (max-width:480px){.wp-agent-lifecycle{width:100%;justify-content:stretch}.wp-agent-lifecycle>button{flex:1 1 100%}.wp-agent-lifecycle .wp-agent-revoke-confirm{width:100%}.wp-agent-lifecycle .wp-agent-revoke-confirm>button{flex:1 1 100%}}"}</style>

      {/* In-flow header. The primary controls (name, state chip, lifecycle
          actions) and the tab bar live here. This is NOT sticky on purpose:
          the global dashboard layout owns the page chrome, and a page-level
          sticky element overlapped the metrics row beneath it on scroll, hiding
          Gate enforcement / Assigned runs / Last active behind it. Keeping the
          header in normal flow means content is never occluded; the solid
          background + bottom border still set it apart visually. */}
      <div
        data-testid="agent-header"
        style={{
          margin: "0 -1.5rem",
          padding: "0.25rem 1.5rem 0.75rem",
          background: "var(--wp-dark, #0b0d11)",
          borderBottom: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        {backLink}

        <div
          style={{
            marginTop: "0.7rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.6rem 1rem",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", minWidth: 0 }}>
              <h1 data-testid="agent-name" style={{ margin: 0, fontSize: "1.4rem", color: "var(--wp-gold, #f1c233)", wordBreak: "break-word" }}>
                {agent.name}
              </h1>
              <StatusPill
                testId="agent-state-chip"
                status={agent.state}
                size="md"
              />
            </div>
            <code
              data-testid="agent-id-mono"
              title={agent.id}
              style={{
                fontFamily: "var(--wp-mono, monospace)",
                fontSize: "0.74rem",
                color: "var(--wp-text-muted, #6b7280)",
                wordBreak: "break-all",
              }}
            >
              {agent.id}
            </code>
          </div>

          {/* Lifecycle controls live in the sticky header so pause/resume/revoke
              are always reachable. Pause/resume are reversible; revoke arms an
              inline confirm before the destructive PATCH. */}
          <div
            data-testid="agent-lifecycle"
            className="wp-agent-lifecycle"
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-end",
            }}
          >
            {agent.state === "active" && (
              <button
                type="button"
                data-testid="agent-pause"
                onClick={() => void runAction("pause")}
                disabled={busy}
                style={{
                  padding: "0.45rem 0.9rem",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  color: "var(--wp-gold, #f1c233)",
                  border: "1px solid var(--wp-gold, #f1c233)",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "..." : "Pause"}
              </button>
            )}
            {(agent.state === "paused" || agent.state === "invited") && (
              <button
                type="button"
                data-testid="agent-resume"
                onClick={() => void runAction("resume")}
                disabled={busy}
                style={{
                  padding: "0.45rem 0.9rem",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  color: "var(--wp-success, #22c55e)",
                  border: "1px solid var(--wp-success, #22c55e)",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "..." : "Resume"}
              </button>
            )}
            {!isRevoked && !confirmingRevoke && (
              <button
                type="button"
                data-testid="agent-revoke"
                onClick={() => setConfirmingRevoke(true)}
                disabled={busy}
                style={{
                  padding: "0.45rem 0.9rem",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  background: "transparent",
                  color: "var(--wp-error, #ef4444)",
                  border: "1px solid var(--wp-error, #ef4444)",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Revoke
              </button>
            )}
            {!isRevoked && confirmingRevoke && (
              <div
                data-testid="agent-revoke-confirm"
                className="wp-agent-revoke-confirm"
                style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}
              >
                <span style={{ fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
                  Revoke permanently? The agent loses its identity and cannot act again.
                </span>
                <button
                  type="button"
                  data-testid="agent-revoke-confirm-yes"
                  onClick={() => void runAction("revoke")}
                  disabled={busy}
                  style={{
                    padding: "0.4rem 0.85rem",
                    borderRadius: "6px",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    background: "var(--wp-error, #ef4444)",
                    color: "#fff",
                    border: "1px solid var(--wp-error, #ef4444)",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  {busy ? "Revoking..." : "Yes, revoke"}
                </button>
                <button
                  type="button"
                  data-testid="agent-revoke-confirm-cancel"
                  onClick={() => setConfirmingRevoke(false)}
                  disabled={busy}
                  style={{
                    padding: "0.4rem 0.85rem",
                    borderRadius: "6px",
                    fontSize: "0.8rem",
                    background: "transparent",
                    color: "var(--wp-text-dim, #aaa)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {isRevoked && (
              <span
                data-testid="agent-revoked-note"
                style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}
              >
                Revoked {relativeTime(agent.revokedAt)}. This agent can no longer act.
              </span>
            )}
          </div>
        </div>

        <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0.4rem 0 0.75rem 0", fontSize: "0.88rem" }}>
          An AI principal governed by OGIAM. Role <strong style={{ color: "var(--wp-text, #eee)", textTransform: "uppercase" }}>{agent.role}</strong>.
        </p>

        {error && (
          <div
            data-testid="agent-action-error"
            style={{
              padding: "0.6rem 0.9rem",
              marginBottom: "0.75rem",
              background: "rgba(239,68,68,0.08)",
              color: "var(--wp-error, #ef4444)",
              border: "1px solid var(--wp-error, #ef4444)",
              borderRadius: "6px",
              fontSize: "0.82rem",
            }}
          >
            {error}
          </div>
        )}

        {/* Tab bar. Switching is instant (local state) with a smooth underline
            transition; the active tab carries the gold accent. */}
        <div
          data-testid="agent-tabs"
          role="tablist"
          style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}
        >
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`agent-tab-${t.key}`}
                data-active={active ? "true" : "false"}
                onClick={() => setTab(t.key)}
                style={{
                  padding: "0.5rem 0.95rem",
                  background: "transparent",
                  border: "none",
                  borderBottom: `2px solid ${active ? "var(--wp-gold, #f1c233)" : "transparent"}`,
                  color: active ? "var(--wp-gold, #f1c233)" : "var(--wp-text-dim, #aaa)",
                  fontSize: "0.88rem",
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                  marginBottom: "-1px",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- COMMAND METRICS: the hero numbers a client scans first ----
          Derived entirely from data the page already fetched (the decision
          ledger, the assigned-work list, the agent record). The decision
          activity series drives the sparkline. Always mounted (across every
          tab) so the trust surface is visible the moment the page loads. */}
      <div data-testid="agent-metrics" style={{ marginTop: "1.5rem" }}>
        <GlassPanel testId="agent-metrics-panel" glow="blue" padded>
          <ConsoleGrid minColWidth={170} gap={18} testId="agent-metrics-grid">
            <MetricTile
              testId="metric-decisions"
              value={metrics.decisions}
              label="Recent decisions"
              kicker="Governed actions"
              accent="var(--wp-text, #e9edf4)"
              sparkline={
                metrics.series.length > 0 ? (
                  <Sparkline
                    data={metrics.series}
                    accent="var(--wp-info, #3b82f6)"
                    area
                    ariaLabel="decision activity trend"
                    testId="metric-decisions-spark"
                  />
                ) : undefined
              }
            />
            <MetricTile
              testId="metric-allowed"
              value={metrics.allowed}
              label="Allowed"
              kicker="Gate verdict"
              accent="var(--wp-success, #22c55e)"
            />
            <MetricTile
              testId="metric-denied"
              value={metrics.denied}
              label="Denied or escalated"
              kicker="Gate verdict"
              accent="var(--wp-error, #ef4444)"
            />
            <MetricTile
              testId="metric-enforcement"
              value={metrics.enforcementPct}
              display={`${metrics.enforcementPct}%`}
              label="Gate enforcement"
              kicker="Would-block share"
              accent="var(--wp-gold, #e8b528)"
            />
            <MetricTile
              testId="metric-runs"
              value={metrics.runs}
              label="Assigned runs"
              kicker="Work items"
              accent="var(--wp-text, #e9edf4)"
            />
            <MetricTile
              testId="metric-last-active"
              display={relativeTime(agent.lastSeenAt)}
              label="Last active"
              kicker="Identity"
              accent="var(--wp-text, #e9edf4)"
            />
          </ConsoleGrid>
        </GlassPanel>
      </div>

      {/* ---- OVERVIEW: identity + system model ---- */}
      <div data-testid="agent-panel-overview" role="tabpanel" style={{ ...panelStyle("overview"), marginTop: "1.5rem" }}>

      {agent.description && (
        <div
          data-testid="agent-description"
          style={{
            padding: "0.9rem 1rem",
            marginBottom: "1.25rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px solid var(--wp-dark-border, #333)",
            borderRadius: "8px",
            fontSize: "0.9rem",
            lineHeight: 1.5,
            color: "var(--wp-text, #eee)",
          }}
        >
          {agent.description}
        </div>
      )}

      <div
        data-testid="agent-identity"
        className="wp-glass"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          padding: "1.1rem 1.2rem",
          marginBottom: "1.25rem",
        }}
      >
        <Field label="Agent id" value={agent.id} testid="agent-id" />
        <Field label="Identity provider" value={agent.identityProvider} testid="agent-identity-provider" />
        <Field
          label="External subject"
          value={agent.externalSubject ?? "not linked"}
          testid="agent-external-subject"
        />
        <Field label="Role" value={agent.role.toUpperCase()} testid="agent-role" />
        <Field label="Owner" value={agent.ownerUserId ?? "unassigned"} testid="agent-owner" />
        <Field
          label="Scan status"
          value={agent.scanStatus === "complete" ? "Complete" : "Pending"}
          testid="agent-scan-status"
        />
        <Field label="Created" value={relativeTime(agent.createdAt)} testid="agent-created" />
        <Field label="Activated" value={relativeTime(agent.activatedAt)} testid="agent-activated" />
        <Field label="Last seen" value={relativeTime(agent.lastSeenAt)} testid="agent-last-seen" />
      </div>

      {/* System model: the self-onboarding scan the agent learned about its own
          toolset. Agent-initiated, so "no scan yet" is the expected state until
          the agent logs in and introspects. We render only the ALLOWED tools by
          default, capped to a scrollable list so the section stays compact. */}
      <div
        data-testid="agent-scan-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.6rem",
          }}
        >
          System model
        </div>

        {/* Manager-triggered scan. Shown whenever the scan is absent so a manager
            can kick the agent's self-onboarding from the dashboard; once a scan is
            present we offer a re-run. The agent must be active to scan (409). */}
        {(scan.kind === "absent" || scan.kind === "present") && (
          <div
            data-testid="agent-run-scan-controls"
            style={{ marginBottom: "0.8rem" }}
          >
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                data-testid="agent-run-scan"
                onClick={() => void runScan()}
                disabled={scanBusy}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  color: "var(--wp-gold, #f1c233)",
                  border: "1px solid var(--wp-gold, #f1c233)",
                  cursor: scanBusy ? "not-allowed" : "pointer",
                  opacity: scanBusy ? 0.6 : 1,
                }}
              >
                {scanBusy
                  ? "Scanning..."
                  : scan.kind === "present"
                    ? "Re-run scan"
                    : "Run onboarding scan"}
              </button>
            </div>
            <div
              data-testid="agent-run-scan-note"
              style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", lineHeight: 1.4 }}
            >
              The agent introspects the platform and learns the tools it can use and its capability ceiling. After it completes you can delegate work from the Assistant by typing the agent&apos;s name followed by an instruction.
            </div>
            {scanError && (
              <div
                data-testid="agent-run-scan-error"
                style={{
                  marginTop: "0.5rem",
                  padding: "0.5rem 0.75rem",
                  background: "rgba(239,68,68,0.08)",
                  color: "var(--wp-error, #ef4444)",
                  border: "1px solid var(--wp-error, #ef4444)",
                  borderRadius: "6px",
                  fontSize: "0.8rem",
                }}
              >
                {scanError}
              </div>
            )}
          </div>
        )}

        {scan.kind === "loading" && (
          <div
            data-testid="agent-scan-loading"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
          >
            Loading...
          </div>
        )}

        {scan.kind === "error" && (
          <div
            data-testid="agent-scan-error"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Could not load the agent&apos;s system model right now.
          </div>
        )}

        {scan.kind === "absent" && (
          <div
            data-testid="agent-scan-empty"
            style={{
              padding: "1rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px dashed var(--wp-dark-border, #333)",
              borderRadius: "8px",
              fontSize: "0.85rem",
              color: "var(--wp-text-muted, #6b7280)",
            }}
          >
            This agent has not run its onboarding scan yet.
          </div>
        )}

        {scan.kind === "present" && (() => {
          const s = scan.scan;
          const m = s.model;
          const allowedTools = m.tools.filter((t) => t.allowed);
          const hiddenCount = m.tools.length - allowedTools.length;
          return (
            <>
              <div
                data-testid="agent-scan-summary"
                style={{ fontSize: "0.9rem", color: "var(--wp-text, #eee)" }}
              >
                Learned{" "}
                <strong>{m.summary.toolCount}</strong> tools, allowed{" "}
                <strong>{m.summary.allowedToolCount}</strong>,{" "}
                <strong>{m.summary.capabilityCount}</strong> capabilities.
              </div>
              <div
                style={{
                  marginTop: "0.3rem",
                  fontSize: "0.78rem",
                  color: "var(--wp-text-muted, #6b7280)",
                }}
              >
                Scan {String(s.scanVersion)} · {relativeTime(s.createdAt)}
              </div>

              <ul
                data-testid="agent-scan-tools"
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0.8rem 0 0 0",
                  maxHeight: "240px",
                  overflowY: "auto",
                }}
              >
                {allowedTools.map((t) => (
                  <li
                    key={t.name}
                    data-testid={`agent-scan-tool-${t.name}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                      padding: "0.4rem 0.6rem",
                      marginBottom: "0.3rem",
                      background: "var(--wp-dark-surface2, #1a1a1a)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      borderRadius: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.82rem",
                        color: "var(--wp-text, #eee)",
                        fontFamily: "var(--wp-mono, monospace)",
                        wordBreak: "break-word",
                      }}
                    >
                      {t.name}
                    </span>
                    {t.isMutation && (
                      <span
                        style={{
                          flexShrink: 0,
                          padding: "0.05rem 0.4rem",
                          borderRadius: "8px",
                          fontSize: "0.65rem",
                          background: "rgba(160,160,160,0.10)",
                          color: "var(--wp-text-muted, #6b7280)",
                          border: "1px solid var(--wp-dark-border, #333)",
                        }}
                      >
                        mutation
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {hiddenCount > 0 && (
                <div
                  data-testid="agent-scan-hidden-note"
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.75rem",
                    color: "var(--wp-text-muted, #6b7280)",
                  }}
                >
                  and {hiddenCount} more the agent cannot use
                </div>
              )}
            </>
          );
        })()}
      </div>

      </div>
      {/* ---- WORK: assigned work + pending writes ---- */}
      <div data-testid="agent-panel-work" role="tabpanel" style={{ ...panelStyle("work"), marginTop: "1.5rem" }}>

      {/* Assigned work. A human assigns a goal; the agent runtime executes it as
          governed steps. This UI assigns and observes only: it never auto-runs a
          task. A blocked task means the OGIAM gate stopped the agent and asked
          the owner to approve, which is the governance working as intended. */}
      <div
        data-testid="agent-tasks-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.3rem",
          }}
        >
          Assigned work
        </div>
        <h3
          style={{
            margin: 0,
            fontSize: "1.05rem",
            fontWeight: 600,
            color: "var(--wp-text, #eee)",
          }}
        >
          Give this agent a job
        </h3>
        <p
          style={{
            margin: "0.35rem 0 0.9rem",
            fontSize: "0.82rem",
            lineHeight: 1.5,
            color: "var(--wp-text-muted, #9ca3af)",
          }}
        >
          Fill in the template and press Assign. The agent plans the objective into
          steps and runs each one through the governance gate on your behalf, guided by
          your success criteria. Number the objective lines to run several actions in
          sequence (for example, search, then summarize).
        </p>

        <form
          data-testid="agent-task-form"
          onSubmit={(e) => {
            e.preventDefault();
            void assignTask();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}
        >
          <label style={TASK_LABEL_STYLE} htmlFor="agent-task-goal-input">
            Objective <span style={{ color: "var(--wp-gold, #e8b528)" }}>*</span>
          </label>
          <textarea
            id="agent-task-goal-input"
            data-testid="agent-task-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={isRevoked || assigning}
            rows={3}
            placeholder={"What should this agent accomplish? Number the steps if there are several, e.g.\n1. Find the latest invoice for ACME\n2. Draft a follow-up email"}
            style={TASK_FIELD_STYLE}
          />

          <label style={TASK_LABEL_STYLE} htmlFor="agent-task-success-input">
            Success criteria <span style={{ color: "var(--wp-gold, #e8b528)" }}>*</span>
          </label>
          <textarea
            id="agent-task-success-input"
            data-testid="agent-task-success"
            value={successCriteria}
            onChange={(e) => setSuccessCriteria(e.target.value)}
            disabled={isRevoked || assigning}
            rows={2}
            placeholder={"How will we know it is done and done well? (the definition of done)"}
            style={TASK_FIELD_STYLE}
          />

          <label style={TASK_LABEL_STYLE} htmlFor="agent-task-context-input">
            Context <span style={{ color: "var(--wp-text-muted, #9ca3af)", fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            id="agent-task-context-input"
            data-testid="agent-task-context"
            value={taskContext}
            onChange={(e) => setTaskContext(e.target.value)}
            disabled={isRevoked || assigning}
            rows={2}
            placeholder={"Links, data, or background the agent should use."}
            style={TASK_FIELD_STYLE}
          />

          {connections.kind === "present" && connections.bound.length > 0 && (
            <>
              <label style={TASK_LABEL_STYLE} htmlFor="agent-task-target-input">
                Target system{" "}
                <span style={{ color: "var(--wp-text-muted, #9ca3af)", fontWeight: 400 }}>(optional)</span>
              </label>
              <select
                id="agent-task-target-input"
                data-testid="agent-task-target"
                value={targetConnectionId}
                onChange={(e) => setTargetConnectionId(e.target.value)}
                disabled={isRevoked || assigning}
                style={TASK_FIELD_STYLE}
              >
                <option value="">No specific system</option>
                {connections.bound.map((c) => (
                  <option key={c.connectorName} value={c.connectorName}>
                    {c.connectorName}
                  </option>
                ))}
              </select>
            </>
          )}

          {assignError && (
            <div
              data-testid="agent-task-error"
              style={{
                padding: "0.5rem 0.75rem",
                background: "rgba(239,68,68,0.08)",
                color: "var(--wp-error, #ef4444)",
                border: "1px solid var(--wp-error, #ef4444)",
                borderRadius: "6px",
                fontSize: "0.8rem",
              }}
            >
              {assignError}
            </div>
          )}
          {(() => {
            const disabled =
              isRevoked ||
              assigning ||
              goal.trim().length === 0 ||
              successCriteria.trim().length === 0;
            return (
              <button
                type="submit"
                data-testid="agent-task-submit"
                disabled={disabled}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.45rem",
                  width: "100%",
                  padding: "0.8rem 1.25rem",
                  borderRadius: "8px",
                  fontSize: "0.95rem",
                  fontWeight: 700,
                  letterSpacing: "0.01em",
                  background: disabled
                    ? "var(--wp-dark-surface2, #1a1a1a)"
                    : "var(--wp-gold, #e8b528)",
                  color: disabled ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #0b0d11)",
                  border: "1px solid var(--wp-gold, #e8b528)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.7 : 1,
                  transition: "background 0.15s, opacity 0.15s",
                }}
              >
                {assigning ? "Assigning..." : "Assign"}
                {!assigning && (
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ flexShrink: 0 }}
                  >
                    <path
                      d="M3 8h10m0 0L9 4m4 4l-4 4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })()}
          <p
            data-testid="agent-task-governance-note"
            style={{
              margin: "0.1rem 0 0",
              fontSize: "0.72rem",
              lineHeight: 1.5,
              color: "var(--wp-text-muted, #6b7280)",
            }}
          >
            If a step is high-risk, the agent stops and asks you to approve. A
            <span style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 600 }}> Blocked </span>
            result below means the gate did its job, not that anything failed.
          </p>
        </form>

        {/* Run-queued control. Shown only when work is already sitting queued
            (e.g. created before execution was wired up, or surfaced by the
            agent's own drain). It drains those tasks via the run endpoint and
            refreshes the list, so a manager can kick them off without
            re-assigning. Disabled while in flight. */}
        {tasks.kind === "present" && hasQueuedTask(tasks.tasks) && (
          <div data-testid="agent-run-queued-controls" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                data-testid="agent-run-queued"
                onClick={() => void runQueuedWork()}
                disabled={runningQueued}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  color: "var(--wp-gold, #f1c233)",
                  border: "1px solid var(--wp-gold, #f1c233)",
                  cursor: runningQueued ? "not-allowed" : "pointer",
                  opacity: runningQueued ? 0.6 : 1,
                }}
              >
                {runningQueued ? "Running..." : "Run queued work"}
              </button>
            </div>
            <div
              data-testid="agent-run-queued-note"
              style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", lineHeight: 1.4 }}
            >
              Runs the tasks already sitting queued and shows each governed step as the agent works through them.
            </div>
          </div>
        )}

        {tasks.kind === "loading" && (
          <div
            data-testid="agent-tasks-loading"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
          >
            Loading...
          </div>
        )}

        {tasks.kind === "error" && (
          <div
            data-testid="agent-tasks-error"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Could not load this agent&apos;s assigned work right now.
          </div>
        )}

        {tasks.kind === "present" && tasks.tasks.length === 0 && (
          <div
            data-testid="agent-tasks-empty"
            style={{
              padding: "1rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px dashed var(--wp-dark-border, #333)",
              borderRadius: "8px",
              fontSize: "0.85rem",
              color: "var(--wp-text-muted, #6b7280)",
            }}
          >
            No work assigned yet.
          </div>
        )}

        {tasks.kind === "present" && tasks.tasks.length > 0 && (
          <ul data-testid="agent-tasks-list" style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: "420px", overflowY: "auto" }}>
            {tasks.tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </ul>
        )}
      </div>

      {/* Pending writes. When a task asks the agent to mutate a client system
          (create/update a record), the OGIAM gate captures the exact validated
          action and stops — it surfaces HERE for a human to approve. Approving
          runs that captured action on the owner's behalf, re-gated + audited;
          this is the other half of a "blocked" task. Scoped to this agent via
          ?agentId; the whole-workspace view lives at /admin/agents/approvals. */}
      <div
        data-testid="agent-approvals-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.3rem",
          }}
        >
          Human-in-the-loop
        </div>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>
          Pending writes
        </h3>
        <p style={{ margin: "0.35rem 0 0.9rem", fontSize: "0.82rem", lineHeight: 1.5, color: "var(--wp-text-muted, #6b7280)" }}>
          Writes this agent proposed are held here until you approve them. Approving runs the exact captured action on the owner&apos;s behalf, re-gated and audited; rejecting drops it. The agent never mutates a client system on its own.
        </p>
        <ApprovalList
          endpoint={`/api/admin/agents/approvals?agentId=${id}`}
          showAgent={false}
          testIdPrefix="agent-approvals"
          emptyText="Nothing awaiting approval right now."
        />
        <ApprovalHistory agentId={id} />
      </div>

      </div>
      {/* ---- ACCESS: connected systems + backup ---- */}
      <div data-testid="agent-panel-access" role="tabpanel" style={{ ...panelStyle("access"), marginTop: "1.5rem" }}>

      {/* Backup agent (failover for uptime). This agent can designate a backup;
          when it goes unhealthy (paused/revoked) or a task stalls, its queued
          work fails over to the backup, which runs it under the SAME OGIAM gate
          and the SAME least-privilege scope. Failover never bypasses governance
          and never escalates scope (the backup must be bound to a superset of
          this agent's connections, enforced server-side). */}
      <div
        data-testid="agent-backup-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.3rem",
          }}
        >
          Uptime
        </div>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>
          Backup agent
        </h3>
        <p style={{ margin: "0.35rem 0 0.9rem", fontSize: "0.82rem", lineHeight: 1.5, color: "var(--wp-text-muted, #6b7280)" }}>
          Designate a backup so this agent&apos;s queued work keeps moving if it is
          paused or revoked. The backup runs the failed-over tasks under the same
          governance gate and the same scope; it only receives work it is already
          authorized for, so failover never escalates access.
        </p>

        <div
          data-testid="agent-backup-current"
          style={{ marginBottom: "0.8rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
        >
          {backupAgentId ? (
            <>
              Current backup:{" "}
              <span
                data-testid="agent-backup-current-id"
                style={{ fontFamily: "var(--wp-mono, monospace)", color: "var(--wp-text, #eee)" }}
              >
                {backupOptions.find((o) => o.id === backupAgentId)?.name ?? backupAgentId}
              </span>
            </>
          ) : (
            <span data-testid="agent-backup-none">No backup designated.</span>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <select
            data-testid="backup-select"
            value={backupSelection}
            onChange={(e) => setBackupSelection(e.target.value)}
            disabled={backupBusy}
            style={{
              flex: "1 1 220px",
              minWidth: 0,
              padding: "0.5rem 0.6rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text, #eee)",
              border: "1px solid var(--wp-dark-border, #333)",
            }}
          >
            <option value="">No backup</option>
            {backupOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="backup-save"
            onClick={() => void saveBackup()}
            disabled={backupBusy}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--wp-gold, #f1c233)",
              color: "#1a1a1a",
              border: "none",
              cursor: backupBusy ? "not-allowed" : "pointer",
              opacity: backupBusy ? 0.6 : 1,
            }}
          >
            {backupBusy ? "Saving..." : "Save"}
          </button>
        </div>

        {backupError && (
          <div
            data-testid="backup-error"
            style={{ marginTop: "0.6rem", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}
          >
            {backupError}
          </div>
        )}
      </div>

      {/* Connected systems (Access). These are the systems THIS agent operates
          on the operator's behalf, the bindings that make it a Salesforce / Jira
          / ... agent. The operator binds an existing workspace connection or
          creates + binds a new one with the username + password they use to sign
          in there (e.g. an account a client invited them to). The password is
          encrypted server-side and never shown again. A username_password
          connection is scannable: it offers a "Run authenticated scan" link into
          the platform-scans surface. Loads independently so a connections
          failure never blanks the profile. */}
      <div
        data-testid="agent-connections-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.3rem",
          }}
        >
          Access
        </div>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>
          Connected systems
        </h3>
        <p style={{ margin: "0.35rem 0 0.9rem", fontSize: "0.82rem", lineHeight: 1.5, color: "var(--wp-text-muted, #6b7280)" }}>
          These are the systems this agent operates on your behalf, the bindings that make it (for example) a Salesforce or Jira agent. Connect an existing system below, or add a new one with the username and password you use to sign in (for example, an account a client invited you to). The password is encrypted and never shown again.
        </p>

        {connections.kind === "loading" && (
          <div
            data-testid="connections-loading"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
          >
            Loading...
          </div>
        )}

        {connections.kind === "error" && (
          <div
            data-testid="connections-error"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Could not load this agent&apos;s connected systems right now.
          </div>
        )}

        {connections.kind === "present" && connections.bound.length === 0 && (
          <div
            data-testid="connections-empty"
            style={{
              padding: "1rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px dashed var(--wp-dark-border, #333)",
              borderRadius: "8px",
              fontSize: "0.85rem",
              color: "var(--wp-text-muted, #6b7280)",
            }}
          >
            No system connected to this agent yet. Connect one below.
          </div>
        )}

        {connections.kind === "present" && connections.bound.length > 0 && (
          <ul data-testid="connections-list" style={{ listStyle: "none", padding: 0, margin: "0 0 1rem 0" }}>
            {connections.bound.map((conn) => {
              const isLogin = conn.authType === "username_password";
              return (
                <li
                  key={conn.connectorName}
                  data-testid={`connection-row-${conn.connectorName}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.6rem",
                    flexWrap: "wrap",
                    padding: "0.6rem 0.7rem",
                    marginBottom: "0.4rem",
                    background: "var(--wp-dark-surface2, #1a1a1a)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    borderRadius: "6px",
                  }}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontSize: "0.88rem",
                          fontWeight: 600,
                          color: "var(--wp-text, #eee)",
                          fontFamily: "var(--wp-mono, monospace)",
                          wordBreak: "break-word",
                        }}
                      >
                        {conn.connectorName}
                      </span>
                      <span
                        data-testid={`connection-authtype-${conn.connectorName}`}
                        style={{
                          flexShrink: 0,
                          padding: "0.05rem 0.4rem",
                          borderRadius: "8px",
                          fontSize: "0.65rem",
                          fontWeight: 600,
                          background: isLogin ? "rgba(34,197,94,0.12)" : "rgba(160,160,160,0.10)",
                          color: isLogin ? "var(--wp-success, #22c55e)" : "var(--wp-text-muted, #6b7280)",
                          border: `1px solid ${isLogin ? "var(--wp-success, #22c55e)" : "var(--wp-dark-border, #333)"}`,
                        }}
                      >
                        {isLogin ? "form login" : conn.authType}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: "0.2rem",
                        fontSize: "0.74rem",
                        color: "var(--wp-text-muted, #6b7280)",
                        wordBreak: "break-all",
                      }}
                    >
                      {conn.baseUrl}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0, flexWrap: "wrap" }}>
                    {isLogin && (
                      <Link
                        href="/admin/platform-scans"
                        data-testid={`scan-link-${conn.connectorName}`}
                        style={{
                          padding: "0.4rem 0.8rem",
                          borderRadius: "6px",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                          background: "var(--wp-dark-surface2, #1a1a1a)",
                          color: "var(--wp-gold, #f1c233)",
                          border: "1px solid var(--wp-gold, #f1c233)",
                          textDecoration: "none",
                        }}
                      >
                        Run authenticated scan
                      </Link>
                    )}
                    <button
                      type="button"
                      data-testid={`unbind-${conn.connectorName}`}
                      onClick={() => void unbindConnection(conn.connectorName)}
                      disabled={binding}
                      style={{
                        padding: "0.4rem 0.8rem",
                        borderRadius: "6px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        background: "transparent",
                        color: "var(--wp-error, #ef4444)",
                        border: "1px solid var(--wp-error, #ef4444)",
                        cursor: binding ? "not-allowed" : "pointer",
                        opacity: binding ? 0.6 : 1,
                      }}
                    >
                      Unbind
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Connect an existing system: bind a workspace connection that was
            created elsewhere to THIS agent. Hidden when nothing is available to
            bind so the operator is steered to the add form below instead. */}
        {connections.kind === "present" && connections.available.length > 0 && (
          <div
            data-testid="bind-existing"
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "flex-end",
              marginBottom: "1rem",
              padding: "0.9rem 1rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "8px",
            }}
          >
            <label style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>
                Connect an existing system
              </span>
              <select
                data-testid="bind-existing-select"
                value={bindSelection}
                onChange={(e) => setBindSelection(e.target.value)}
                style={{
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                  textOverflow: "ellipsis",
                }}
              >
                <option value="">Choose a system…</option>
                {connections.available.map((conn) => (
                  <option key={conn.connectorName} value={conn.connectorName}>
                    {conn.connectorName} ({conn.baseUrl.replace(/^https?:\/\//, "")})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="bind-existing-submit"
              onClick={() => void bindExisting()}
              disabled={binding || bindSelection.trim().length === 0}
              style={{
                padding: "0.5rem 1.1rem",
                borderRadius: "6px",
                fontSize: "0.85rem",
                fontWeight: 600,
                background: "var(--wp-gold, #f1c233)",
                color: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-gold, #f1c233)",
                cursor: binding || bindSelection.trim().length === 0 ? "not-allowed" : "pointer",
                opacity: binding || bindSelection.trim().length === 0 ? 0.6 : 1,
              }}
            >
              {binding ? "Connecting..." : "Connect system"}
            </button>
          </div>
        )}

        {/* Add a connection. POSTs the username_password body the contract
            expects; on success the password is cleared (never shown again) and
            the masked list reloads. */}
        <form
          data-testid="add-connection-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addConnection();
          }}
          style={{
            marginTop: "0.5rem",
            padding: "0.9rem 1rem",
            background: "var(--wp-dark-surface2, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
            borderRadius: "8px",
          }}
        >
          <div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.7rem", color: "var(--wp-text, #eee)" }}>
            Add a new system and connect it to this agent
          </div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <label style={{ flex: "1 1 200px", minWidth: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Connection type</span>
              <select
                data-testid="conn-auth-type"
                value={connAuthType}
                onChange={(e) => {
                  const next = e.target.value as "username_password" | "oauth_password";
                  setConnAuthType(next);
                  /* Switch the login-path default to the right idiom for the
                     selected mode, but only when it is still the other mode's
                     default so a typed override is preserved. */
                  if (next === "oauth_password" && connLoginPath.trim() === "/api/auth/login") {
                    setConnLoginPath("/services/oauth2/token");
                  } else if (next === "username_password" && connLoginPath.trim() === "/services/oauth2/token") {
                    setConnLoginPath("/api/auth/login");
                  }
                }}
                style={{
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              >
                <option value="username_password">Username &amp; password</option>
                <option value="oauth_password">OAuth password (Salesforce)</option>
              </select>
            </label>
          </div>
          {connAuthType === "oauth_password" && (
            <p
              data-testid="conn-oauth-help"
              style={{ margin: "0 0 0.6rem", fontSize: "0.74rem", lineHeight: 1.5, color: "var(--wp-text-muted, #6b7280)" }}
            >
              OAuth Resource-Owner-Password grant. The platform URL is the login
              host (https://test.salesforce.com for a sandbox,
              https://login.salesforce.com for production). For Salesforce, append
              your security token to the password (password + security token).
            </p>
          )}
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>System name</span>
              <input
                type="text"
                data-testid="conn-name"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
                placeholder="acme-portal"
                style={{
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              />
            </label>
            <label style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Platform URL</span>
              <input
                type="text"
                data-testid="conn-base-url"
                value={connBaseUrl}
                onChange={(e) => setConnBaseUrl(e.target.value)}
                placeholder="https://app.client.com"
                style={{
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              />
            </label>
          </div>
          {connAuthType === "oauth_password" && (
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Consumer key / client_id</span>
                <input
                  type="text"
                  data-testid="conn-client-id"
                  value={connClientId}
                  onChange={(e) => setConnClientId(e.target.value)}
                  autoComplete="off"
                  placeholder="3MVG9..."
                  style={{
                    padding: "0.5rem 0.65rem",
                    fontSize: "0.85rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    color: "var(--wp-text, #eee)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    borderRadius: "6px",
                  }}
                />
              </label>
              <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Consumer secret</span>
                <input
                  type="password"
                  data-testid="conn-client-secret"
                  value={connClientSecret}
                  onChange={(e) => setConnClientSecret(e.target.value)}
                  autoComplete="off"
                  style={{
                    padding: "0.5rem 0.65rem",
                    fontSize: "0.85rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    color: "var(--wp-text, #eee)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    borderRadius: "6px",
                  }}
                />
              </label>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Username / email</span>
              <input
                type="text"
                data-testid="conn-username"
                value={connUsername}
                onChange={(e) => setConnUsername(e.target.value)}
                autoComplete="off"
                style={{
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              />
            </label>
            <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Password</span>
              <input
                type="password"
                data-testid="conn-password"
                value={connPassword}
                onChange={(e) => setConnPassword(e.target.value)}
                autoComplete="new-password"
                style={{
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <label style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>
                {connAuthType === "oauth_password" ? "Token path" : "Login path"}
              </span>
              <input
                type="text"
                data-testid="conn-login-path"
                value={connLoginPath}
                onChange={(e) => setConnLoginPath(e.target.value)}
                placeholder={connAuthType === "oauth_password" ? "/services/oauth2/token" : "/api/auth/login"}
                style={{
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.85rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                  fontFamily: "var(--wp-mono, monospace)",
                }}
              />
            </label>
            {connAuthType === "username_password" && (
              <label style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={{ fontSize: "0.74rem", color: "var(--wp-text-dim, #aaa)" }}>Session cookie</span>
                <input
                  type="text"
                  data-testid="conn-session-cookie"
                  value={connSessionCookie}
                  onChange={(e) => setConnSessionCookie(e.target.value)}
                  placeholder="session"
                  style={{
                    padding: "0.5rem 0.65rem",
                    fontSize: "0.85rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    color: "var(--wp-text, #eee)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    borderRadius: "6px",
                    fontFamily: "var(--wp-mono, monospace)",
                  }}
                />
              </label>
            )}
          </div>

          {connectionError && (
            <div
              data-testid="connection-error"
              style={{
                marginBottom: "0.6rem",
                padding: "0.5rem 0.75rem",
                background: "rgba(239,68,68,0.08)",
                color: "var(--wp-error, #ef4444)",
                border: "1px solid var(--wp-error, #ef4444)",
                borderRadius: "6px",
                fontSize: "0.8rem",
              }}
            >
              {connectionError}
            </div>
          )}

          <button
            type="submit"
            data-testid="add-connection-submit"
            disabled={connecting}
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--wp-gold, #f1c233)",
              color: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-gold, #f1c233)",
              cursor: connecting ? "not-allowed" : "pointer",
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? "Connecting..." : "Connect system"}
          </button>

          <p
            data-testid="connection-invite-help"
            style={{ margin: "0.7rem 0 0", fontSize: "0.74rem", lineHeight: 1.5, color: "var(--wp-text-muted, #6b7280)" }}
          >
            Got an invite link from a client? Accept it on their system to set your username and password, then add them here.
          </p>
        </form>
      </div>

      </div>
      {/* ---- ACTIVITY: behavior drift + agent log ---- */}
      <div data-testid="agent-panel-activity" role="tabpanel" style={{ ...panelStyle("activity"), marginTop: "1.5rem" }}>

      {/* Behavior + drift. The gate keeps an agent in check across model changes
          by comparing recent behavior to a captured baseline; a shift past the
          threshold raises the drift score and, when critical, auto-pauses the
          agent for owner review. The baseline is the agent's "normal" snapshot,
          drift events are each check's verdict over time. Loads independently so
          a drift failure never blanks the profile. */}
      <div
        data-testid="agent-drift-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: "0.6rem",
          }}
        >
          Behavior and drift
        </div>

        {drift.kind === "loading" && (
          <div
            data-testid="agent-drift-loading"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
          >
            Loading...
          </div>
        )}

        {drift.kind === "error" && (
          <div
            data-testid="agent-drift-error"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Could not load this agent&apos;s behavior and drift right now.
          </div>
        )}

        {drift.kind === "present" && (() => {
          const { baseline, events, latest } = drift;
          const vc = latest ? driftVerdictColor(latest.verdict) : driftVerdictColor("insufficient_data");
          return (
            <>
              {/* Status line: the latest verdict chip + drift score, with a clear
                  red note when the agent was auto-paused for drift. */}
              <div
                data-testid="agent-drift-status"
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
              >
                <span
                  data-testid="agent-drift-status-chip"
                  style={{
                    flexShrink: 0,
                    padding: "0.1rem 0.5rem",
                    borderRadius: "10px",
                    fontSize: "0.68rem",
                    fontWeight: 600,
                    textTransform: "capitalize",
                    background: vc.bg,
                    color: vc.fg,
                    border: `1px solid ${vc.fg}`,
                  }}
                >
                  {latest ? latest.verdict.replace(/_/g, " ") : "no checks yet"}
                </span>
                {latest && (
                  <span style={{ fontSize: "0.82rem", color: "var(--wp-text, #eee)" }}>
                    Drift score <strong>{latest.driftScore.toFixed(2)}</strong>, checked {relativeTime(latest.createdAt)}
                  </span>
                )}
                {!latest && (
                  <span style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #6b7280)" }}>
                    No drift check has run yet.
                  </span>
                )}
              </div>

              {latest?.action === "paused" && (
                <div
                  data-testid="agent-drift-paused-note"
                  style={{
                    marginTop: "0.6rem",
                    padding: "0.6rem 0.8rem",
                    background: "rgba(239,68,68,0.08)",
                    color: "var(--wp-error, #ef4444)",
                    border: "1px solid var(--wp-error, #ef4444)",
                    borderRadius: "6px",
                    fontSize: "0.82rem",
                  }}
                >
                  This agent was auto-paused for drift. Its recent behavior shifted past the threshold; it needs owner review before it can act again.
                </div>
              )}

              {/* Baseline info: when it was captured and over how many decisions, or
                  a calm "no baseline yet" state. */}
              <div
                data-testid="agent-drift-baseline"
                style={{
                  marginTop: "0.8rem",
                  padding: "0.7rem 0.8rem",
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "6px",
                }}
              >
                <div style={{ fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                  {baseline
                    ? `Baseline captured ${relativeTime(baseline.capturedAt)} over ${baseline.decisionCount} decision${baseline.decisionCount === 1 ? "" : "s"}.`
                    : "No baseline yet."}
                </div>
                <div style={{ marginTop: "0.3rem", fontSize: "0.74rem", color: "var(--wp-text-muted, #6b7280)" }}>
                  A baseline is the agent&apos;s normal behavior, used to detect drift.
                </div>
              </div>

              {/* Controls. Both POST, then refetch drift; the drift check also
                  refetches the agent so an auto-pause shows in the state chip. */}
              <div
                style={{
                  marginTop: "0.8rem",
                  display: "flex",
                  gap: "0.6rem",
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  data-testid="agent-set-baseline"
                  onClick={() => void setBaseline()}
                  disabled={driftBusy}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    background: "var(--wp-dark-surface2, #1a1a1a)",
                    color: "var(--wp-gold, #f1c233)",
                    border: "1px solid var(--wp-gold, #f1c233)",
                    cursor: driftBusy ? "not-allowed" : "pointer",
                    opacity: driftBusy ? 0.6 : 1,
                  }}
                >
                  {driftBusy ? "..." : "Set baseline"}
                </button>
                <button
                  type="button"
                  data-testid="agent-check-drift"
                  onClick={() => void checkDriftNow()}
                  disabled={driftBusy}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    background: "var(--wp-dark-surface2, #1a1a1a)",
                    color: "var(--wp-text, #eee)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    cursor: driftBusy ? "not-allowed" : "pointer",
                    opacity: driftBusy ? 0.6 : 1,
                  }}
                >
                  {driftBusy ? "..." : "Check drift now"}
                </button>
              </div>

              <div style={{ marginTop: "0.6rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}>
                This is how the gate keeps agents in check across model changes: a behavior shift past the threshold auto-pauses the agent.
              </div>

              {/* Drift history: each check's verdict chip, score, action, and when. */}
              {events.length === 0 ? (
                <div
                  data-testid="agent-drift-empty"
                  style={{
                    marginTop: "0.8rem",
                    padding: "1rem",
                    background: "var(--wp-dark-surface2, #1a1a1a)",
                    border: "1px dashed var(--wp-dark-border, #333)",
                    borderRadius: "8px",
                    fontSize: "0.85rem",
                    color: "var(--wp-text-muted, #6b7280)",
                  }}
                >
                  No drift checks recorded yet.
                </div>
              ) : (
                <ul
                  data-testid="agent-drift-events"
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0.8rem 0 0 0",
                    maxHeight: "240px",
                    overflowY: "auto",
                  }}
                >
                  {events.map((ev) => {
                    const ec = driftVerdictColor(ev.verdict);
                    return (
                      <li
                        key={ev.id}
                        data-testid={`agent-drift-event-${ev.id}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                          padding: "0.4rem 0.6rem",
                          marginBottom: "0.3rem",
                          background: "var(--wp-dark-surface2, #1a1a1a)",
                          border: "1px solid var(--wp-dark-border, #333)",
                          borderRadius: "6px",
                        }}
                      >
                        <span
                          data-testid={`agent-drift-event-${ev.id}-verdict`}
                          style={{
                            flexShrink: 0,
                            padding: "0.05rem 0.4rem",
                            borderRadius: "8px",
                            fontSize: "0.65rem",
                            fontWeight: 600,
                            textTransform: "capitalize",
                            background: ec.bg,
                            color: ec.fg,
                            border: `1px solid ${ec.fg}`,
                          }}
                        >
                          {ev.verdict.replace(/_/g, " ")}
                        </span>
                        <span style={{ fontSize: "0.8rem", color: "var(--wp-text, #eee)" }}>
                          score <strong>{ev.driftScore.toFixed(2)}</strong>
                        </span>
                        {ev.action === "paused" && (
                          <span
                            style={{
                              flexShrink: 0,
                              padding: "0.05rem 0.4rem",
                              borderRadius: "8px",
                              fontSize: "0.65rem",
                              fontWeight: 600,
                              background: "rgba(239,68,68,0.12)",
                              color: "var(--wp-error, #ef4444)",
                              border: "1px solid var(--wp-error, #ef4444)",
                            }}
                          >
                            paused
                          </span>
                        )}
                        <span style={{ flex: "1 1 auto", minWidth: 0 }} />
                        <span style={{ flexShrink: 0, fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}>
                          {relativeTime(ev.createdAt)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          );
        })()}
      </div>

      {/* Agent log: the IAM auditing pillar. A granular audit trail of every
          governed action this agent took (newest first). Each row is a clickable
          summary that expands into the full trail from prompt to response: the
          redacted input, the governance decision, the redacted result, the
          acting identity, and the tamper-evident hash chain. The same ledger
          feeds drift detection and the agent's learning, so nothing it does is
          lost. Loads independently so a log failure never blanks the profile. */}
      <div
        data-testid="agent-log-section"
        className="wp-glass"
        style={{
          marginBottom: "1.5rem",
          padding: "1.1rem 1.2rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
            flexWrap: "wrap",
            marginBottom: "0.6rem",
          }}
        >
          <div
            style={{
              fontSize: "0.72rem",
              color: "var(--wp-text-muted, #6b7280)",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
            }}
          >
            Agent log
          </div>
          <button
            type="button"
            data-testid="agent-log-refresh"
            onClick={() => void refreshLog()}
            disabled={logBusy}
            style={{
              padding: "0.35rem 0.8rem",
              borderRadius: "6px",
              fontSize: "0.78rem",
              fontWeight: 600,
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text, #eee)",
              border: "1px solid var(--wp-dark-border, #333)",
              cursor: logBusy ? "not-allowed" : "pointer",
              opacity: logBusy ? 0.6 : 1,
            }}
          >
            {logBusy ? "..." : "Refresh"}
          </button>
        </div>

        <div
          data-testid="agent-log-note"
          style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", lineHeight: 1.4, marginBottom: "0.8rem" }}
        >
          The full audit trail of every governed action this agent took: this is the IAM record. Click any row to expand the complete trail, from the redacted prompt through the governance decision to the redacted response. The same ledger feeds drift detection and the agent&apos;s learning, so nothing it does is lost.
        </div>

        {log.kind === "loading" && (
          <div
            data-testid="agent-log-loading"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}
          >
            Loading...
          </div>
        )}

        {log.kind === "error" && (
          <div
            data-testid="agent-log-error"
            style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Could not load this agent&apos;s log right now.
          </div>
        )}

        {log.kind === "present" && log.entries.length === 0 && (
          <div
            data-testid="agent-log-empty"
            style={{
              padding: "1rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px dashed var(--wp-dark-border, #333)",
              borderRadius: "8px",
              fontSize: "0.85rem",
              color: "var(--wp-text-muted, #6b7280)",
            }}
          >
            No governed actions recorded yet.
          </div>
        )}

        {log.kind === "present" && log.entries.length > 0 && (() => {
          const shown = log.entries.slice(0, MAX_LOG_ROWS);
          const total = log.entries.length;
          return (
            <>
              <ul
                data-testid="agent-log-list"
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  maxHeight: "320px",
                  overflowY: "auto",
                }}
              >
                {shown.map((e) => (
                  <LogRow key={e.id} entry={e} />
                ))}
              </ul>
              <div
                data-testid="agent-log-count"
                style={{ marginTop: "0.5rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}
              >
                Showing {shown.length} of {total} governed action{total === 1 ? "" : "s"}. Click any row for the full trail.
              </div>
            </>
          );
        })()}
      </div>

      {/* Bridge to the agent's governed activity. The OGIAM explorer, filtered
          to this agent, is where its gated actions show up once it acts. */}
      <Link
        href={`/admin/ogiam?agent=${encodeURIComponent(id)}`}
        data-testid="agent-activity-link"
        style={{
          display: "inline-block",
          marginTop: "1.25rem",
          padding: "0.6rem 1rem",
          borderRadius: "6px",
          fontSize: "0.85rem",
          fontWeight: 600,
          background: "var(--wp-dark-surface, #1f1f22)",
          color: "var(--wp-gold, #f1c233)",
          border: "1px solid var(--wp-dark-border, #333)",
          textDecoration: "none",
        }}
      >
        View this agent&apos;s gated actions &rarr;
      </Link>
      </div>
    </div>
  );
}
