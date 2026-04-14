-- 013_onboarding.sql — Onboarding checklist templates + per-employee tracking.
--
-- Backs the HR > Onboarding sub-tab. Templates are reusable across
-- employees; instances are per-employee snapshots of a template with
-- step-level completion tracking.

-- Checklist templates (reusable across employees)
CREATE TABLE IF NOT EXISTS apex_onboarding_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,           -- e.g. "Engineering Hire", "Sales Hire", "Operations Hire"
  department TEXT,              -- optional department filter
  steps JSONB NOT NULL,         -- array of { step_id, title, description, required, category }
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-employee onboarding instance
CREATE TABLE IF NOT EXISTS apex_onboarding_instances (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES apex_employees(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES apex_onboarding_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL,  -- denormalized for display even if template is deleted
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | cancelled
  steps JSONB NOT NULL,         -- snapshot of steps + completion state
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apex_onboarding_employee ON apex_onboarding_instances(employee_id);
CREATE INDEX IF NOT EXISTS idx_apex_onboarding_status ON apex_onboarding_instances(status);
