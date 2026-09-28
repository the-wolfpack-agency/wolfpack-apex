/**
 * Read the gate-decision event stream into the client-facing safety summary that
 * backs the "kept you safe" panel. Workspace-scoped, never throws (safeQuery ->
 * empty summary on any read failure).
 *
 * The headline metric is `dataKeptFromModel`: decisions where no LLM was invoked
 * (model_invoked null) - i.e. the client's data never left for a model. That is
 * the single biggest AI-adoption blocker, answered with a number.
 */
import { safeQuery } from "@/lib/db";

export interface GateSafetySummary {
  total: number;
  allowed: number;
  autoFixed: number;
  escalatedToHuman: number;
  /** Hard blocks + escalations that carried a finding: bad changes stopped before
   *  they could land. Governs AI- and human-authored changes alike. */
  badChangesPrevented: number;
  /** Decisions where NO model was invoked - the client's data never went to an
   *  LLM. The headline safety metric. */
  dataKeptFromModel: number;
  /** Distinct compliance frameworks enforced across the decisions. */
  frameworks: string[];
  /** Most recent decisions for the panel's list. */
  recent: GateDecisionRow[];
  /** Changes waiting on a human production decision (prod-promote require_human),
   *  each with the preview URL to review - the ONE human touchpoint, surfaced. */
  awaitingProd: { previewUrl: string | null; recordedSeq: number | null; createdAt: string }[];
}

export interface GateDecisionRow {
  gate: string;
  verdict: "allow" | "auto_fix" | "require_human" | "deny";
  modelInvoked: string | null;
  findings: number;
  recordedSeq: number | null;
  createdAt: string;
  /** A preview URL the gate handed off (preview-verify / prod-promote), so a
   *  human can open the exact build their production decision is about. */
  previewUrl: string | null;
}

interface EventRow {
  metadata: Record<string, unknown> | string;
  timestamp: string;
}

function asObj(m: EventRow["metadata"]): Record<string, unknown> {
  if (typeof m === "string") {
    try { return JSON.parse(m) as Record<string, unknown>; } catch { return {}; }
  }
  return m ?? {};
}

const asVerdict = (v: unknown): GateDecisionRow["verdict"] =>
  v === "auto_fix" || v === "require_human" || v === "deny" ? v : "allow";

const EMPTY: GateSafetySummary = {
  total: 0, allowed: 0, autoFixed: 0, escalatedToHuman: 0, badChangesPrevented: 0,
  dataKeptFromModel: 0, frameworks: [], recent: [], awaitingProd: [],
};

export async function gateSafetySummary(workspaceId: string | null | undefined, limit = 200): Promise<GateSafetySummary> {
  if (!workspaceId) return EMPTY;
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const { rows } = await safeQuery<EventRow>(
    `SELECT metadata, timestamp::text AS timestamp
       FROM instinct_events
      WHERE event_type = 'ai_gate.decision'
        AND metadata->>'workspace_id' = $1
      ORDER BY timestamp DESC
      LIMIT ${lim}`,
    [workspaceId],
  );

  const frameworks = new Set<string>();
  const recent: GateDecisionRow[] = [];
  const awaitingProd: GateSafetySummary["awaitingProd"] = [];
  let allowed = 0, autoFixed = 0, escalatedToHuman = 0, badChangesPrevented = 0, dataKeptFromModel = 0;

  for (const r of rows) {
    const m = asObj(r.metadata);
    const verdict = asVerdict(m.verdict);
    // model_used is "" when no model saw the data; data_kept_from_model is the
    // authoritative boolean the event stored. Tolerate the legacy model_invoked
    // shape too so an older event still reads.
    const modelUsed = typeof m.model_used === "string" ? m.model_used : typeof m.model_invoked === "string" ? m.model_invoked : "";
    const modelInvoked = modelUsed.length > 0 ? modelUsed : null;
    const dataKept = m.data_kept_from_model === true || m.data_kept_from_model === "true" || (m.data_kept_from_model === undefined && modelInvoked === null);
    const findings = Number(m.findings) || 0;

    if (verdict === "allow") allowed++;
    else if (verdict === "auto_fix") autoFixed++;
    else if (verdict === "require_human") escalatedToHuman++;
    if ((verdict === "deny" || verdict === "require_human") && findings > 0) badChangesPrevented++;
    if (dataKept) dataKeptFromModel++;
    const fw = m.frameworks;
    if (typeof fw === "string") for (const f of fw.split(",").filter(Boolean)) frameworks.add(f);
    else if (Array.isArray(fw)) for (const f of fw) if (typeof f === "string") frameworks.add(f);

    if (verdict === "require_human" && typeof m.gate === "string" && m.gate === "prod-promote" && awaitingProd.length < 10) {
      awaitingProd.push({ previewUrl: typeof m.preview_url === "string" && m.preview_url.length > 0 ? m.preview_url : null, recordedSeq: m.recorded_seq == null ? null : Number(m.recorded_seq), createdAt: r.timestamp });
    }
    if (recent.length < 15) {
      recent.push({
        gate: typeof m.gate === "string" ? m.gate : "(unknown)",
        verdict,
        modelInvoked,
        findings,
        recordedSeq: Number(m.recorded_seq) || null,
        createdAt: r.timestamp,
        previewUrl: typeof m.preview_url === "string" && m.preview_url.length > 0 ? m.preview_url : null,
      });
    }
  }

  return {
    total: rows.length,
    allowed, autoFixed, escalatedToHuman, badChangesPrevented, dataKeptFromModel,
    frameworks: [...frameworks],
    recent,
    awaitingProd,
  };
}
