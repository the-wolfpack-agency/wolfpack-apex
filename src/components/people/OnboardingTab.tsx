"use client";

/**
 * HR > Onboarding sub-tab.
 *
 * Three sections:
 *   1. Active Onboardings — cards with progress bars and expandable step checklists
 *   2. Start New Onboarding — button that opens a form to pick employee + template
 *   3. Completed — collapsed by default, shows past onboardings
 */

import { useEffect, useState, useCallback } from "react";
import { authHeaders, jsonHeaders } from "./auth";

/* ----------------------------- Types ---------------------------------- */

interface OnboardingStep {
  step_id: string;
  title: string;
  description: string;
  required: boolean;
  category: string;
  completed: boolean;
  completed_by: string | null;
  completed_at: string | null;
}

interface OnboardingInstance {
  id: string;
  employee_id: string;
  template_id: string | null;
  template_name: string;
  status: "in_progress" | "completed" | "cancelled";
  steps: OnboardingStep[];
  started_at: string;
  completed_at: string | null;
  employee_name?: string;
  employee_email?: string;
  employee_department?: string;
}

interface OnboardingTemplate {
  id: string;
  name: string;
  department: string | null;
  steps: OnboardingStep[];
}

interface Employee {
  id: string;
  full_name: string;
  department: string | null;
  status: string;
}

/* ----------------------------- Component ------------------------------ */

export function OnboardingTab() {
  const [instances, setInstances] = useState<OnboardingInstance[]>([]);
  const [templates, setTemplates] = useState<OnboardingTemplate[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [instR, tmplR, empR] = await Promise.all([
        fetch("/api/people/onboarding?all=true", { headers: authHeaders() }),
        fetch("/api/people/onboarding/templates", { headers: authHeaders() }),
        fetch("/api/people/employees", { headers: authHeaders() }),
      ]);
      if (instR.ok) {
        const d = await instR.json();
        setInstances(d.instances ?? []);
      }
      if (tmplR.ok) {
        const d = await tmplR.json();
        setTemplates(d.templates ?? []);
      }
      if (empR.ok) {
        const d = await empR.json();
        setEmployees(d.employees ?? []);
      }
    } catch {
      setError("Failed to load onboarding data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleStart() {
    if (!selectedEmployee || !selectedTemplate) return;
    setError(null);
    const r = await fetch("/api/people/onboarding", {
      method: "POST",
      headers: { ...authHeaders(), ...jsonHeaders() },
      body: JSON.stringify({ employee_id: selectedEmployee, template_id: selectedTemplate }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({ error: "Failed" }));
      setError(d.error);
      return;
    }
    setShowForm(false);
    setSelectedEmployee("");
    setSelectedTemplate("");
    await load();
  }

  async function handleStepToggle(instanceId: string, stepId: string, currentlyCompleted: boolean) {
    const action = currentlyCompleted ? "uncomplete" : "complete";
    const r = await fetch(`/api/people/onboarding/${instanceId}`, {
      method: "PATCH",
      headers: { ...authHeaders(), ...jsonHeaders() },
      body: JSON.stringify({ step_id: stepId, action }),
    });
    if (r.ok) {
      const d = await r.json();
      setInstances((prev) =>
        prev.map((inst) => (inst.id === instanceId ? d.instance : inst)),
      );
    }
  }

  async function handleCancel(instanceId: string) {
    const r = await fetch(`/api/people/onboarding/${instanceId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (r.ok) {
      await load();
    }
  }

  function toggleExpand(id: string) {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) return <div data-tab="onboarding">Loading...</div>;

  const active = instances.filter((i) => i.status === "in_progress");
  const completed = instances.filter((i) => i.status === "completed" || i.status === "cancelled");

  return (
    <div data-tab="onboarding">
      {error && (
        <div style={{ color: "#e53e3e", padding: "0.5rem 1rem", background: "rgba(229,62,62,0.1)", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.85rem" }}>
          {error}
        </div>
      )}

      {/* ---- Active Onboardings ---- */}
      <h2 style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>Active Onboardings</h2>
      {active.length === 0 ? (
        <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
          No active onboardings. Start one below.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
          {active.map((inst) => {
            const done = inst.steps.filter((s) => s.completed).length;
            const total = inst.steps.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const expanded = expandedCards.has(inst.id);

            return (
              <div
                key={inst.id}
                data-testid="onboarding-card"
                style={{ border: "1px solid var(--wp-border)", borderRadius: "8px", padding: "1rem", background: "var(--wp-card)" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => toggleExpand(inst.id)}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{inst.employee_name ?? inst.employee_id}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
                      {inst.template_name} &middot; Started {new Date(inst.started_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{done}/{total} steps</div>
                    <div style={{ width: "120px", height: "6px", background: "var(--wp-border)", borderRadius: "3px", overflow: "hidden", marginTop: "4px" }}>
                      <div data-testid="progress-bar" style={{ width: `${pct}%`, height: "100%", background: "var(--wp-gold)", borderRadius: "3px", transition: "width 0.3s" }} />
                    </div>
                  </div>
                </div>

                {expanded && (
                  <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--wp-border)", paddingTop: "0.75rem" }}>
                    {inst.steps.map((step) => (
                      <label
                        key={step.step_id}
                        style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", padding: "0.35rem 0", cursor: "pointer", fontSize: "0.85rem" }}
                      >
                        <input
                          type="checkbox"
                          data-testid={`step-checkbox-${step.step_id}`}
                          checked={step.completed}
                          onChange={() => handleStepToggle(inst.id, step.step_id, step.completed)}
                          style={{ marginTop: "2px" }}
                        />
                        <div>
                          <span style={{ fontWeight: step.required ? 600 : 400, textDecoration: step.completed ? "line-through" : "none", color: step.completed ? "var(--wp-text-dim)" : "var(--wp-text)" }}>
                            {step.title}
                          </span>
                          {step.required && <span style={{ fontSize: "0.7rem", color: "var(--wp-gold)", marginLeft: "0.3rem" }}>required</span>}
                          <div style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>{step.description}</div>
                        </div>
                      </label>
                    ))}
                    <button
                      onClick={() => handleCancel(inst.id)}
                      style={{ marginTop: "0.5rem", padding: "0.3rem 0.75rem", fontSize: "0.75rem", background: "transparent", border: "1px solid #e53e3e", color: "#e53e3e", borderRadius: "4px", cursor: "pointer" }}
                    >
                      Cancel Onboarding
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Start New Onboarding ---- */}
      {!showForm ? (
        <button
          data-testid="start-onboarding-btn"
          onClick={() => setShowForm(true)}
          style={{ padding: "0.6rem 1.25rem", background: "var(--wp-gold)", color: "#000", border: "none", borderRadius: "6px", fontWeight: 600, cursor: "pointer", marginBottom: "1.5rem" }}
        >
          Start New Onboarding
        </button>
      ) : (
        <div data-testid="start-onboarding-form" style={{ border: "1px solid var(--wp-border)", borderRadius: "8px", padding: "1rem", background: "var(--wp-card)", marginBottom: "1.5rem", maxWidth: "400px" }}>
          <h3 style={{ fontSize: "1rem", marginTop: 0, marginBottom: "0.75rem" }}>Start Onboarding</h3>
          <div style={{ marginBottom: "0.5rem" }}>
            <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "0.25rem", color: "var(--wp-text-dim)" }}>Employee</label>
            <select
              data-testid="employee-select"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
              style={{ width: "100%", padding: "0.4rem", borderRadius: "4px", border: "1px solid var(--wp-border)", background: "var(--wp-bg)", color: "var(--wp-text)" }}
            >
              <option value="">Select employee...</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.full_name}{emp.department ? ` (${emp.department})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "0.25rem", color: "var(--wp-text-dim)" }}>Template</label>
            <select
              data-testid="template-select"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              style={{ width: "100%", padding: "0.4rem", borderRadius: "4px", border: "1px solid var(--wp-border)", background: "var(--wp-bg)", color: "var(--wp-text)" }}
            >
              <option value="">Select template...</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.department ? ` (${t.department})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              data-testid="submit-onboarding"
              onClick={handleStart}
              disabled={!selectedEmployee || !selectedTemplate}
              style={{ padding: "0.4rem 1rem", background: "var(--wp-gold)", color: "#000", border: "none", borderRadius: "4px", fontWeight: 600, cursor: "pointer", opacity: (!selectedEmployee || !selectedTemplate) ? 0.5 : 1 }}
            >
              Start
            </button>
            <button
              onClick={() => { setShowForm(false); setError(null); }}
              style={{ padding: "0.4rem 1rem", background: "transparent", color: "var(--wp-text-dim)", border: "1px solid var(--wp-border)", borderRadius: "4px", cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Completed Onboardings ---- */}
      {completed.length > 0 && (
        <div>
          <button
            data-testid="toggle-completed"
            onClick={() => setShowCompleted(!showCompleted)}
            style={{ background: "transparent", border: "none", color: "var(--wp-text-dim)", cursor: "pointer", fontSize: "0.9rem", padding: "0.4rem 0" }}
          >
            {showCompleted ? "Hide" : "Show"} Completed ({completed.length})
          </button>
          {showCompleted && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              {completed.map((inst) => {
                const done = inst.steps.filter((s) => s.completed).length;
                return (
                  <div
                    key={inst.id}
                    data-testid="completed-card"
                    style={{ border: "1px solid var(--wp-border)", borderRadius: "8px", padding: "0.75rem", background: "var(--wp-card)", opacity: 0.7 }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{inst.employee_name ?? inst.employee_id}</span>
                        <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)", marginLeft: "0.5rem" }}>{inst.template_name}</span>
                      </div>
                      <div style={{ fontSize: "0.8rem" }}>
                        <span style={{ color: inst.status === "completed" ? "#38a169" : "#e53e3e" }}>
                          {inst.status === "completed" ? "Completed" : "Cancelled"}
                        </span>
                        <span style={{ color: "var(--wp-text-dim)", marginLeft: "0.5rem" }}>{done}/{inst.steps.length} steps</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
