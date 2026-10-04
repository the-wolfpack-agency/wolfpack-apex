"use client";
/**
 * The guided intake wizard: LEAD the user to a well-formed request. Pick a goal ->
 * answer only the decisions that change the result (with plain-language help) ->
 * review the assembled request -> start. The open prompt box is still available via
 * "describe it myself", but the guided path is the default (the product thesis:
 * don't hand a non-expert a blank box).
 */
import { useState } from "react";
import { NEON, neonGlow } from "./neon";
import { INTAKE_GOALS, goalById, isComplete, composeRequest, type IntakeGoal } from "./intake-flow";

export default function GuidedIntake({
  onSubmit, onFreeform,
}: { onSubmit: (prompt: string) => void; onFreeform?: () => void }): React.ReactElement {
  const [goalId, setGoalId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const goal = goalId ? goalById(goalId) : undefined;

  const pick = (g: IntakeGoal) => {
    setGoalId(g.id);
    // pre-fill the recommended defaults so the safe path is the default.
    const d: Record<string, string> = {};
    for (const s of g.steps) if (s.defaultValue) d[s.id] = s.defaultValue;
    setAnswers(d);
  };
  const reset = () => { setGoalId(null); setAnswers({}); };

  // ---- Goal selection ----
  if (!goal) {
    return (
      <div data-testid="intake-goals" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <div style={{ color: NEON.textDim, fontSize: "0.82rem", textAlign: "center" }}>What do you want to do?</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.6rem" }}>
          {INTAKE_GOALS.map((g) => (
            <button
              key={g.id} type="button" data-testid={`goal-${g.id}`} onClick={() => pick(g)}
              style={{ textAlign: "left", background: NEON.surface, border: `1px solid ${NEON.accentDim}`, borderRadius: 12, padding: "0.7rem 0.85rem", cursor: "pointer", color: NEON.text }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = NEON.accent; e.currentTarget.style.boxShadow = neonGlow(NEON.accent); }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = NEON.accentDim; e.currentTarget.style.boxShadow = "none"; }}
            >
              <div style={{ color: NEON.accent, fontSize: "0.9rem", fontWeight: 600 }}>{g.label}</div>
              <div style={{ color: NEON.textDim, fontSize: "0.76rem", marginTop: "0.2rem" }}>{g.blurb}</div>
            </button>
          ))}
        </div>
        {onFreeform && (
          <button type="button" data-testid="freeform" onClick={onFreeform} style={{ alignSelf: "center", background: "transparent", border: "none", color: NEON.textDim, fontSize: "0.76rem", cursor: "pointer", textDecoration: "underline" }}>
            or describe it myself
          </button>
        )}
      </div>
    );
  }

  // ---- Guided steps (all shown, with help; required gate the Start button) ----
  const ready = isComplete(goal, answers);
  const preview = composeRequest(goal, answers);
  const set = (id: string, v: string) => setAnswers((p) => ({ ...p, [id]: v }));

  return (
    <div data-testid="intake-steps" style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button type="button" data-testid="intake-back" onClick={reset} style={{ background: "transparent", border: `1px solid ${NEON.accentDim}`, color: NEON.textDim, borderRadius: 8, padding: "0.25rem 0.6rem", fontSize: "0.72rem", cursor: "pointer" }}>← change</button>
        <div style={{ color: NEON.accent, fontSize: "0.85rem", fontWeight: 600 }}>{goal.label}</div>
      </div>

      {goal.steps.map((s) => (
        <div key={s.id} data-testid={`step-${s.id}`} style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <label style={{ fontSize: "0.85rem", color: NEON.text }}>
            {s.question}{s.required ? <span style={{ color: NEON.accent }}> *</span> : null}
          </label>
          {s.help && <div style={{ fontSize: "0.72rem", color: NEON.textDim }}>{s.help}</div>}
          {s.kind === "text" ? (
            <input
              type="text" data-testid={`input-${s.id}`} value={answers[s.id] ?? ""} placeholder={s.placeholder}
              onChange={(e) => set(s.id, e.target.value)}
              style={{ background: NEON.deep, border: `1px solid ${NEON.accentDim}`, borderRadius: 8, color: NEON.text, padding: "0.5rem 0.7rem", fontSize: "0.85rem", outline: "none" }}
            />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {(s.options ?? []).map((o) => {
                const active = (answers[s.id] ?? s.defaultValue) === o.value;
                return (
                  <button
                    key={o.value} type="button" data-testid={`opt-${s.id}-${o.value}`} onClick={() => set(s.id, o.value)}
                    title={o.hint}
                    style={{ background: active ? NEON.accentDim : "transparent", border: `1px solid ${active ? NEON.accent : NEON.accentDim}`, color: active ? NEON.text : NEON.textDim, borderRadius: 999, padding: "0.3rem 0.75rem", fontSize: "0.78rem", cursor: "pointer" }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
          {s.kind === "choice" && (answers[s.id] ?? s.defaultValue) && (
            <div style={{ fontSize: "0.7rem", color: NEON.textDim }}>
              {(s.options ?? []).find((o) => o.value === (answers[s.id] ?? s.defaultValue))?.hint}
            </div>
          )}
        </div>
      ))}

      {/* Review the assembled request before starting - transparency, no guessing. */}
      <div data-testid="intake-preview" style={{ borderTop: `1px solid ${NEON.accentDim}`, paddingTop: "0.6rem" }}>
        <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.04em", color: NEON.textDim }}>We'll ask the factory to:</div>
        <div style={{ fontSize: "0.82rem", color: NEON.text, marginTop: "0.25rem" }}>{preview || "…"}</div>
      </div>

      <button
        type="button" data-testid="intake-start" disabled={!ready} onClick={() => onSubmit(preview)}
        style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${ready ? NEON.accent : NEON.pending}`, color: ready ? NEON.accent : NEON.textDim, borderRadius: 10, padding: "0.5rem 1.1rem", fontSize: "0.85rem", cursor: ready ? "pointer" : "not-allowed", boxShadow: ready ? neonGlow(NEON.accent) : "none" }}
      >
        Start the build
      </button>
    </div>
  );
}
