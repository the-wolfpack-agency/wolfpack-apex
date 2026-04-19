/**
 * Onboarding library — Instinct's HR > Onboarding sub-tab.
 *
 * Checklist templates (reusable) + per-employee onboarding instances
 * with step-level completion tracking. Every action emits an analytics
 * event and generates insights when milestones are hit.
 *
 * Closed-loop: completion time, stalled onboardings, and step
 * uncomplete patterns are all surfaced as insights so the brain
 * learns which onboarding flows work best.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { HrInsight } from "@/lib/benefits";
import { saveInsights } from "@/lib/benefits";

/* ----------------------------- Types ---------------------------------- */

export type StepCategory =
  | "paperwork"
  | "access"
  | "training"
  | "equipment"
  | "introductions";

export interface OnboardingStep {
  step_id: string;
  title: string;
  description: string;
  required: boolean;
  category: StepCategory;
  completed: boolean;
  completed_by: string | null;
  completed_at: string | null;
}

export interface OnboardingTemplate {
  id: string;
  name: string;
  department: string | null;
  steps: OnboardingStep[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface OnboardingInstance {
  id: string;
  employee_id: string;
  template_id: string | null;
  template_name: string;
  status: "in_progress" | "completed" | "cancelled";
  steps: OnboardingStep[];
  started_at: string;
  completed_at: string | null;
  created_by: string;
  // joined fields (optional, from list queries)
  employee_name?: string;
  employee_email?: string;
  employee_department?: string;
}

/* ----------------------- Default templates ---------------------------- */

function tpl(
  id: string,
  title: string,
  desc: string,
  required: boolean,
  category: StepCategory,
): OnboardingStep {
  return {
    step_id: id,
    title,
    description: desc,
    required,
    category,
    completed: false,
    completed_by: null,
    completed_at: null,
  };
}

export const DEFAULT_TEMPLATES: OnboardingTemplate[] = [
  {
    id: "obt_default_engineering",
    name: "Engineering Hire",
    department: "Engineering",
    steps: [
      tpl("eng_1", "Sign offer letter", "Employee signs and returns offer letter", true, "paperwork"),
      tpl("eng_2", "Complete I-9 verification", "Employment eligibility verification with HR", true, "paperwork"),
      tpl("eng_3", "Submit W-4 form", "Federal tax withholding certificate", true, "paperwork"),
      tpl("eng_4", "Set up GitHub access", "Add to organization, assign team repositories", true, "access"),
      tpl("eng_5", "Provision development laptop", "Order and configure development machine", true, "equipment"),
      tpl("eng_6", "Set up email and Slack", "Create email account and add to Slack workspace", true, "access"),
      tpl("eng_7", "Complete security training", "Mandatory security awareness training module", true, "training"),
      tpl("eng_8", "Meet the team", "Schedule 1:1 introductions with team members", false, "introductions"),
    ],
    created_by: "system",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "obt_default_sales",
    name: "Sales Hire",
    department: "Sales",
    steps: [
      tpl("sal_1", "Sign offer letter", "Employee signs and returns offer letter", true, "paperwork"),
      tpl("sal_2", "Complete I-9 verification", "Employment eligibility verification with HR", true, "paperwork"),
      tpl("sal_3", "Submit W-4 form", "Federal tax withholding certificate", true, "paperwork"),
      tpl("sal_4", "Set up CRM access", "Provision CRM account and assign territory", true, "access"),
      tpl("sal_5", "Set up email and Slack", "Create email account and add to Slack workspace", true, "access"),
      tpl("sal_6", "Complete product training", "Product knowledge and demo certification", true, "training"),
      tpl("sal_7", "Complete sales methodology training", "Sales process and methodology onboarding", true, "training"),
      tpl("sal_8", "Meet assigned accounts", "Introduction calls with key account contacts", false, "introductions"),
    ],
    created_by: "system",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "obt_default_operations",
    name: "Operations Hire",
    department: "Operations",
    steps: [
      tpl("ops_1", "Sign offer letter", "Employee signs and returns offer letter", true, "paperwork"),
      tpl("ops_2", "Complete I-9 verification", "Employment eligibility verification with HR", true, "paperwork"),
      tpl("ops_3", "Submit W-4 form", "Federal tax withholding certificate", true, "paperwork"),
      tpl("ops_4", "Enroll in benefits", "Select health, dental, and vision plans", true, "paperwork"),
      tpl("ops_5", "Set up email and Slack", "Create email account and add to Slack workspace", true, "access"),
      tpl("ops_6", "Issue badge and keys", "Physical access credentials for office and facilities", true, "equipment"),
      tpl("ops_7", "Complete safety training", "Workplace safety and emergency procedures", true, "training"),
      tpl("ops_8", "Meet department heads", "Introduction meetings with cross-functional leads", false, "introductions"),
    ],
    created_by: "system",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

/* ----------------------- Template CRUD -------------------------------- */

export async function createTemplate(
  name: string,
  steps: Omit<OnboardingStep, "completed" | "completed_by" | "completed_at">[],
  createdBy: string,
  userRole: string,
  department?: string,
): Promise<OnboardingTemplate> {
  const id = `obt_${randomUUID()}`;
  const fullSteps: OnboardingStep[] = steps.map((s) => ({
    ...s,
    completed: false,
    completed_by: null,
    completed_at: null,
  }));
  const now = new Date().toISOString();
  await safeQuery(
    `INSERT INTO instinct_onboarding_templates (id, name, department, steps, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, name, department ?? null, JSON.stringify(fullSteps), createdBy, now, now],
  );

  trackEvent("hr.onboarding_template_created", createdBy, userRole, {
    template_id: id,
    template_name: name,
    step_count: fullSteps.length,
  });

  return {
    id,
    name,
    department: department ?? null,
    steps: fullSteps,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };
}

export async function listTemplates(): Promise<OnboardingTemplate[]> {
  const r = await safeQuery<OnboardingTemplate>(
    `SELECT * FROM instinct_onboarding_templates ORDER BY created_at DESC`,
  );
  const dbTemplates = r.rows.map((row) => ({
    ...row,
    steps: typeof row.steps === "string" ? JSON.parse(row.steps as string) : row.steps,
  }));
  // Merge with defaults (defaults first, then custom)
  const defaultIds = new Set(DEFAULT_TEMPLATES.map((t) => t.id));
  const customOnly = dbTemplates.filter((t) => !defaultIds.has(t.id));
  return [...DEFAULT_TEMPLATES, ...customOnly];
}

/* ----------------------- Instance lifecycle --------------------------- */

export async function startOnboarding(
  employeeId: string,
  templateId: string,
  createdBy: string,
  userRole: string,
): Promise<OnboardingInstance> {
  // Resolve template
  const allTemplates = await listTemplates();
  const template = allTemplates.find((t) => t.id === templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  // Snapshot steps (reset completion state)
  const steps: OnboardingStep[] = template.steps.map((s) => ({
    ...s,
    completed: false,
    completed_by: null,
    completed_at: null,
  }));

  const id = `ob_${randomUUID()}`;
  const now = new Date().toISOString();

  await safeQuery(
    `INSERT INTO apex_onboarding_instances (id, employee_id, template_id, template_name, status, steps, started_at, created_by)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7)`,
    [id, employeeId, templateId, template.name, JSON.stringify(steps), now, createdBy],
  );

  // Update employee status to onboarding
  await safeQuery(
    `UPDATE apex_employees SET status = 'onboarding', updated_at = NOW() WHERE id = $1`,
    [employeeId],
  );

  trackEvent("hr.onboarding_started", createdBy, userRole, {
    instance_id: id,
    employee_id: employeeId,
    template_id: templateId,
    template_name: template.name,
    step_count: steps.length,
    required_step_count: steps.filter((s) => s.required).length,
  });

  return {
    id,
    employee_id: employeeId,
    template_id: templateId,
    template_name: template.name,
    status: "in_progress",
    steps,
    started_at: now,
    completed_at: null,
    created_by: createdBy,
  };
}

export async function completeStep(
  instanceId: string,
  stepId: string,
  completedBy: string,
  userRole: string,
): Promise<OnboardingInstance> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error(`Instance not found: ${instanceId}`);
  if (instance.status === "cancelled") throw new Error("Cannot modify a cancelled onboarding");

  const steps: OnboardingStep[] = instance.steps.map((s) =>
    s.step_id === stepId
      ? { ...s, completed: true, completed_by: completedBy, completed_at: new Date().toISOString() }
      : s,
  );

  const completedCount = steps.filter((s) => s.completed).length;
  const requiredSteps = steps.filter((s) => s.required);
  const allRequiredDone = requiredSteps.every((s) => s.completed);

  let status = instance.status;
  let completedAt = instance.completed_at;

  if (allRequiredDone && status !== "completed") {
    status = "completed";
    completedAt = new Date().toISOString();
  }

  await safeQuery(
    `UPDATE apex_onboarding_instances SET steps = $2, status = $3, completed_at = $4 WHERE id = $1`,
    [instanceId, JSON.stringify(steps), status, completedAt],
  );

  trackEvent("hr.onboarding_step_completed", completedBy, userRole, {
    instance_id: instanceId,
    step_id: stepId,
    completed_count: completedCount,
    total_steps: steps.length,
    completion_pct: Math.round((completedCount / steps.length) * 100),
  });

  if (status === "completed" && instance.status !== "completed") {
    // Auto-complete: update employee status + emit event + generate insight
    await safeQuery(
      `UPDATE apex_employees SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [instance.employee_id],
    );

    const startedAt = new Date(instance.started_at);
    const daysToComplete = Math.round(
      (Date.now() - startedAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    trackEvent("hr.onboarding_completed", completedBy, userRole, {
      instance_id: instanceId,
      employee_id: instance.employee_id,
      template_name: instance.template_name,
      days_to_complete: daysToComplete,
      total_steps: steps.length,
    });

    // Look up employee name for insight
    const empR = await safeQuery<{ full_name: string }>(
      `SELECT full_name FROM apex_employees WHERE id = $1`,
      [instance.employee_id],
    );
    const empName = empR.rows[0]?.full_name ?? instance.employee_id;

    const insight: HrInsight = {
      category: "onboarding",
      severity: "info",
      title: `Onboarding completed in ${daysToComplete} day${daysToComplete !== 1 ? "s" : ""} for ${empName}`,
      body: `${empName} finished all ${requiredSteps.length} required steps of the "${instance.template_name}" onboarding in ${daysToComplete} day${daysToComplete !== 1 ? "s" : ""}. ${completedCount} of ${steps.length} total steps were completed.`,
      related_id: instanceId,
      source_rule: "onboarding_completed",
    };
    await saveInsights([insight], completedBy, userRole);
  }

  return { ...instance, steps, status: status as OnboardingInstance["status"], completed_at: completedAt };
}

export async function uncompleteStep(
  instanceId: string,
  stepId: string,
  changedBy: string,
  userRole: string,
): Promise<OnboardingInstance> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error(`Instance not found: ${instanceId}`);
  if (instance.status === "cancelled") throw new Error("Cannot modify a cancelled onboarding");

  const wasCompleted = instance.status === "completed";

  const steps: OnboardingStep[] = instance.steps.map((s) =>
    s.step_id === stepId
      ? { ...s, completed: false, completed_by: null, completed_at: null }
      : s,
  );

  // If it was completed, reopen it
  let status: OnboardingInstance["status"] = instance.status;
  let completedAt = instance.completed_at;
  const uncompleteTarget = instance.steps.find((s) => s.step_id === stepId);
  if (wasCompleted && uncompleteTarget?.required) {
    status = "in_progress";
    completedAt = null;

    // Revert employee status back to onboarding
    await safeQuery(
      `UPDATE apex_employees SET status = 'onboarding', updated_at = NOW() WHERE id = $1`,
      [instance.employee_id],
    );
  }

  await safeQuery(
    `UPDATE apex_onboarding_instances SET steps = $2, status = $3, completed_at = $4 WHERE id = $1`,
    [instanceId, JSON.stringify(steps), status, completedAt],
  );

  const completedCount = steps.filter((s) => s.completed).length;

  trackEvent("hr.onboarding_step_uncompleted", changedBy, userRole, {
    instance_id: instanceId,
    step_id: stepId,
    was_completed: wasCompleted,
    completed_count: completedCount,
    total_steps: steps.length,
    completion_pct: Math.round((completedCount / steps.length) * 100),
  });

  return { ...instance, steps, status, completed_at: completedAt };
}

export async function getOnboardingForEmployee(
  employeeId: string,
): Promise<OnboardingInstance[]> {
  const r = await safeQuery<OnboardingInstance>(
    `SELECT oi.*, ae.full_name AS employee_name, ae.email AS employee_email, ae.department AS employee_department
     FROM apex_onboarding_instances oi
     LEFT JOIN apex_employees ae ON ae.id = oi.employee_id
     WHERE oi.employee_id = $1
     ORDER BY oi.started_at DESC`,
    [employeeId],
  );
  return r.rows.map(parseInstanceRow);
}

export async function listActiveOnboardings(): Promise<OnboardingInstance[]> {
  const r = await safeQuery<OnboardingInstance>(
    `SELECT oi.*, ae.full_name AS employee_name, ae.email AS employee_email, ae.department AS employee_department
     FROM apex_onboarding_instances oi
     LEFT JOIN apex_employees ae ON ae.id = oi.employee_id
     WHERE oi.status = 'in_progress'
     ORDER BY oi.started_at ASC`,
  );
  return r.rows.map(parseInstanceRow);
}

export async function listAllOnboardings(): Promise<OnboardingInstance[]> {
  const r = await safeQuery<OnboardingInstance>(
    `SELECT oi.*, ae.full_name AS employee_name, ae.email AS employee_email, ae.department AS employee_department
     FROM apex_onboarding_instances oi
     LEFT JOIN apex_employees ae ON ae.id = oi.employee_id
     ORDER BY oi.started_at DESC`,
  );
  return r.rows.map(parseInstanceRow);
}

export async function cancelOnboarding(
  instanceId: string,
  cancelledBy: string,
  userRole: string,
): Promise<OnboardingInstance> {
  const instance = await getInstance(instanceId);
  if (!instance) throw new Error(`Instance not found: ${instanceId}`);
  if (instance.status === "cancelled") throw new Error("Already cancelled");

  await safeQuery(
    `UPDATE apex_onboarding_instances SET status = 'cancelled' WHERE id = $1`,
    [instanceId],
  );

  trackEvent("hr.onboarding_cancelled", cancelledBy, userRole, {
    instance_id: instanceId,
    employee_id: instance.employee_id,
    template_name: instance.template_name,
    steps_completed: instance.steps.filter((s) => s.completed).length,
    total_steps: instance.steps.length,
  });

  return { ...instance, status: "cancelled" };
}

/* -------------------- Stalled onboarding check ----------------------- */

/**
 * Generate insights for onboardings that have been in_progress for
 * more than `stalledDays` days. Call this periodically or on page load.
 */
export async function checkStalledOnboardings(
  userId: string,
  userRole: string,
  stalledDays: number = 14,
): Promise<HrInsight[]> {
  const active = await listActiveOnboardings();
  const now = Date.now();
  const insights: HrInsight[] = [];

  for (const inst of active) {
    const started = new Date(inst.started_at).getTime();
    const daysElapsed = Math.round((now - started) / (1000 * 60 * 60 * 24));
    if (daysElapsed >= stalledDays) {
      const empName = inst.employee_name ?? inst.employee_id;
      const completedCount = inst.steps.filter((s) => s.completed).length;
      insights.push({
        category: "onboarding",
        severity: "attention",
        title: `Onboarding stalled — ${empName} has been onboarding for ${daysElapsed} days`,
        body: `${empName} started the "${inst.template_name}" onboarding ${daysElapsed} days ago and has completed ${completedCount} of ${inst.steps.length} steps. Consider following up to unblock progress.`,
        related_id: inst.id,
        source_rule: "onboarding_stalled",
      });
    }
  }

  if (insights.length > 0) {
    await saveInsights(insights, userId, userRole);
  }

  return insights;
}

/* ----------------------------- Helpers -------------------------------- */

async function getInstance(id: string): Promise<OnboardingInstance | null> {
  const r = await safeQuery<OnboardingInstance>(
    `SELECT * FROM apex_onboarding_instances WHERE id = $1`,
    [id],
  );
  if (r.rows.length === 0) return null;
  return parseInstanceRow(r.rows[0]);
}

function parseInstanceRow(row: OnboardingInstance): OnboardingInstance {
  return {
    ...row,
    steps: typeof row.steps === "string" ? JSON.parse(row.steps as string) : row.steps,
  };
}

/** Exported for API routes */
export { getInstance };
