-- 297_rls_workspace_policies_remaining.sql - enable RLS with the same
-- workspace policy on the remaining workspace-scoped tables.
--
-- Same policy shape and the same safety argument as migration 296: NO FORCE,
-- the owner connection the app uses today bypasses it, no roles, no grants, no
-- data, idempotent, paired .down.sql (drops the policy and disables RLS, which
-- is exactly the state before this migration).
--
-- DELIBERATELY NOT COVERED (phase 2, listed in docs/security/rls-cutover.md):
-- tables read before a workspace can be known, so a workspace policy would
-- hide the very row that establishes the workspace.
--   instinct_team_members              principal table: login resolves the user before any workspace is known
--   instinct_invites                   principal table: invite acceptance runs before the invitee has a session
--   instinct_delegation_issuers        read while verifying a delegation token, before a workspace is bound
--   instinct_delegation_replay         replay ledger checked during token verification
--   instinct_edge_policy               read by the Forcefield edge guard on unauthenticated traffic
--   instinct_org_entitlements          tenancy entitlements resolved before the request workspace
--   github_app_installations           GitHub webhooks arrive with no Instinct session
--   integration_health                 written by the integration-health cron across workspaces
--   instinct_connector_credentials     read by the integration probes cron across workspaces

-- ai_spend_baseline
ALTER TABLE ai_spend_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_spend_baseline_ws_isolation ON ai_spend_baseline;
CREATE POLICY ai_spend_baseline_ws_isolation ON ai_spend_baseline
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_baselines
ALTER TABLE instinct_agent_baselines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_baselines_ws_isolation ON instinct_agent_baselines;
CREATE POLICY instinct_agent_baselines_ws_isolation ON instinct_agent_baselines
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_blocked_fingerprints
ALTER TABLE instinct_agent_blocked_fingerprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_blocked_fingerprints_ws_isolation ON instinct_agent_blocked_fingerprints;
CREATE POLICY instinct_agent_blocked_fingerprints_ws_isolation ON instinct_agent_blocked_fingerprints
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_connections
ALTER TABLE instinct_agent_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_connections_ws_isolation ON instinct_agent_connections;
CREATE POLICY instinct_agent_connections_ws_isolation ON instinct_agent_connections
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_containment
ALTER TABLE instinct_agent_containment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_containment_ws_isolation ON instinct_agent_containment;
CREATE POLICY instinct_agent_containment_ws_isolation ON instinct_agent_containment
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_drift_events
ALTER TABLE instinct_agent_drift_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_drift_events_ws_isolation ON instinct_agent_drift_events;
CREATE POLICY instinct_agent_drift_events_ws_isolation ON instinct_agent_drift_events
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_memory
ALTER TABLE instinct_agent_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_memory_ws_isolation ON instinct_agent_memory;
CREATE POLICY instinct_agent_memory_ws_isolation ON instinct_agent_memory
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_model_regressions
ALTER TABLE instinct_agent_model_regressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_model_regressions_ws_isolation ON instinct_agent_model_regressions;
CREATE POLICY instinct_agent_model_regressions_ws_isolation ON instinct_agent_model_regressions
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_operations
ALTER TABLE instinct_agent_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_operations_ws_isolation ON instinct_agent_operations;
CREATE POLICY instinct_agent_operations_ws_isolation ON instinct_agent_operations
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_operator_blocklist
ALTER TABLE instinct_agent_operator_blocklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_operator_blocklist_ws_isolation ON instinct_agent_operator_blocklist;
CREATE POLICY instinct_agent_operator_blocklist_ws_isolation ON instinct_agent_operator_blocklist
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_pending_approvals
ALTER TABLE instinct_agent_pending_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_pending_approvals_ws_isolation ON instinct_agent_pending_approvals;
CREATE POLICY instinct_agent_pending_approvals_ws_isolation ON instinct_agent_pending_approvals
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_run_spend
ALTER TABLE instinct_agent_run_spend ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_run_spend_ws_isolation ON instinct_agent_run_spend;
CREATE POLICY instinct_agent_run_spend_ws_isolation ON instinct_agent_run_spend
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_scans
ALTER TABLE instinct_agent_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_scans_ws_isolation ON instinct_agent_scans;
CREATE POLICY instinct_agent_scans_ws_isolation ON instinct_agent_scans
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_screenshots
ALTER TABLE instinct_agent_screenshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_screenshots_ws_isolation ON instinct_agent_screenshots;
CREATE POLICY instinct_agent_screenshots_ws_isolation ON instinct_agent_screenshots
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_sightings
ALTER TABLE instinct_agent_sightings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_sightings_ws_isolation ON instinct_agent_sightings;
CREATE POLICY instinct_agent_sightings_ws_isolation ON instinct_agent_sightings
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agent_tasks
ALTER TABLE instinct_agent_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agent_tasks_ws_isolation ON instinct_agent_tasks;
CREATE POLICY instinct_agent_tasks_ws_isolation ON instinct_agent_tasks
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_agents
ALTER TABLE instinct_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_agents_ws_isolation ON instinct_agents;
CREATE POLICY instinct_agents_ws_isolation ON instinct_agents
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_code_gate_policy
ALTER TABLE instinct_code_gate_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_code_gate_policy_ws_isolation ON instinct_code_gate_policy;
CREATE POLICY instinct_code_gate_policy_ws_isolation ON instinct_code_gate_policy
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_document_recognitions
ALTER TABLE instinct_document_recognitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_document_recognitions_ws_isolation ON instinct_document_recognitions;
CREATE POLICY instinct_document_recognitions_ws_isolation ON instinct_document_recognitions
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_corrections
ALTER TABLE instinct_factory_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_corrections_ws_isolation ON instinct_factory_corrections;
CREATE POLICY instinct_factory_corrections_ws_isolation ON instinct_factory_corrections
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_exemplars
ALTER TABLE instinct_factory_exemplars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_exemplars_ws_isolation ON instinct_factory_exemplars;
CREATE POLICY instinct_factory_exemplars_ws_isolation ON instinct_factory_exemplars
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_failure_memory
ALTER TABLE instinct_factory_failure_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_failure_memory_ws_isolation ON instinct_factory_failure_memory;
CREATE POLICY instinct_factory_failure_memory_ws_isolation ON instinct_factory_failure_memory
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_memory_provenance
ALTER TABLE instinct_factory_memory_provenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_memory_provenance_ws_isolation ON instinct_factory_memory_provenance;
CREATE POLICY instinct_factory_memory_provenance_ws_isolation ON instinct_factory_memory_provenance
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_repair_recipes
ALTER TABLE instinct_factory_repair_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_repair_recipes_ws_isolation ON instinct_factory_repair_recipes;
CREATE POLICY instinct_factory_repair_recipes_ws_isolation ON instinct_factory_repair_recipes
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_factory_reuse_corpus
ALTER TABLE instinct_factory_reuse_corpus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_factory_reuse_corpus_ws_isolation ON instinct_factory_reuse_corpus;
CREATE POLICY instinct_factory_reuse_corpus_ws_isolation ON instinct_factory_reuse_corpus
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_forcefield_canaries
ALTER TABLE instinct_forcefield_canaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_forcefield_canaries_ws_isolation ON instinct_forcefield_canaries;
CREATE POLICY instinct_forcefield_canaries_ws_isolation ON instinct_forcefield_canaries
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_hr_scanned_documents
ALTER TABLE instinct_hr_scanned_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_hr_scanned_documents_ws_isolation ON instinct_hr_scanned_documents;
CREATE POLICY instinct_hr_scanned_documents_ws_isolation ON instinct_hr_scanned_documents
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_invoices
ALTER TABLE instinct_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_invoices_ws_isolation ON instinct_invoices;
CREATE POLICY instinct_invoices_ws_isolation ON instinct_invoices
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_job_codes_edits
ALTER TABLE instinct_job_codes_edits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_job_codes_edits_ws_isolation ON instinct_job_codes_edits;
CREATE POLICY instinct_job_codes_edits_ws_isolation ON instinct_job_codes_edits
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_learned_hostile_signatures
ALTER TABLE instinct_learned_hostile_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_learned_hostile_signatures_ws_isolation ON instinct_learned_hostile_signatures;
CREATE POLICY instinct_learned_hostile_signatures_ws_isolation ON instinct_learned_hostile_signatures
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_mcp_manifest_pins
ALTER TABLE instinct_mcp_manifest_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_mcp_manifest_pins_ws_isolation ON instinct_mcp_manifest_pins;
CREATE POLICY instinct_mcp_manifest_pins_ws_isolation ON instinct_mcp_manifest_pins
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_meeting_insights
ALTER TABLE instinct_meeting_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_insights_ws_isolation ON instinct_meeting_insights;
CREATE POLICY instinct_meeting_insights_ws_isolation ON instinct_meeting_insights
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_meeting_prep_signals
ALTER TABLE instinct_meeting_prep_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_prep_signals_ws_isolation ON instinct_meeting_prep_signals;
CREATE POLICY instinct_meeting_prep_signals_ws_isolation ON instinct_meeting_prep_signals
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_operator_reputation
ALTER TABLE instinct_operator_reputation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_operator_reputation_ws_isolation ON instinct_operator_reputation;
CREATE POLICY instinct_operator_reputation_ws_isolation ON instinct_operator_reputation
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_receipt_scans
ALTER TABLE instinct_receipt_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_receipt_scans_ws_isolation ON instinct_receipt_scans;
CREATE POLICY instinct_receipt_scans_ws_isolation ON instinct_receipt_scans
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_reputation_optin
ALTER TABLE instinct_reputation_optin ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_reputation_optin_ws_isolation ON instinct_reputation_optin;
CREATE POLICY instinct_reputation_optin_ws_isolation ON instinct_reputation_optin
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_scan_anomaly_runs
ALTER TABLE instinct_scan_anomaly_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_scan_anomaly_runs_ws_isolation ON instinct_scan_anomaly_runs;
CREATE POLICY instinct_scan_anomaly_runs_ws_isolation ON instinct_scan_anomaly_runs
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_scan_host_baseline
ALTER TABLE instinct_scan_host_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_scan_host_baseline_ws_isolation ON instinct_scan_host_baseline;
CREATE POLICY instinct_scan_host_baseline_ws_isolation ON instinct_scan_host_baseline
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_sharepoint_sources
ALTER TABLE instinct_sharepoint_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_sharepoint_sources_ws_isolation ON instinct_sharepoint_sources;
CREATE POLICY instinct_sharepoint_sources_ws_isolation ON instinct_sharepoint_sources
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_site_acceptance
ALTER TABLE instinct_site_acceptance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_site_acceptance_ws_isolation ON instinct_site_acceptance;
CREATE POLICY instinct_site_acceptance_ws_isolation ON instinct_site_acceptance
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_site_acceptance_runs
ALTER TABLE instinct_site_acceptance_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_site_acceptance_runs_ws_isolation ON instinct_site_acceptance_runs;
CREATE POLICY instinct_site_acceptance_runs_ws_isolation ON instinct_site_acceptance_runs
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_site_finding_triage
ALTER TABLE instinct_site_finding_triage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_site_finding_triage_ws_isolation ON instinct_site_finding_triage;
CREATE POLICY instinct_site_finding_triage_ws_isolation ON instinct_site_finding_triage
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_spec_diff_runs
ALTER TABLE instinct_spec_diff_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_spec_diff_runs_ws_isolation ON instinct_spec_diff_runs;
CREATE POLICY instinct_spec_diff_runs_ws_isolation ON instinct_spec_diff_runs
  FOR ALL USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_time_entries
ALTER TABLE instinct_time_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_time_entries_ws_isolation ON instinct_time_entries;
CREATE POLICY instinct_time_entries_ws_isolation ON instinct_time_entries
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_user_feedback
ALTER TABLE instinct_user_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_user_feedback_ws_isolation ON instinct_user_feedback;
CREATE POLICY instinct_user_feedback_ws_isolation ON instinct_user_feedback
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_walked_system_maps
ALTER TABLE instinct_walked_system_maps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_walked_system_maps_ws_isolation ON instinct_walked_system_maps;
CREATE POLICY instinct_walked_system_maps_ws_isolation ON instinct_walked_system_maps
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_workspace_model_keys
ALTER TABLE instinct_workspace_model_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_workspace_model_keys_ws_isolation ON instinct_workspace_model_keys;
CREATE POLICY instinct_workspace_model_keys_ws_isolation ON instinct_workspace_model_keys
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_workspace_offboarding_log
ALTER TABLE instinct_workspace_offboarding_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_workspace_offboarding_log_ws_isolation ON instinct_workspace_offboarding_log;
CREATE POLICY instinct_workspace_offboarding_log_ws_isolation ON instinct_workspace_offboarding_log
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_courses
ALTER TABLE lms_courses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_courses_ws_isolation ON lms_courses;
CREATE POLICY lms_courses_ws_isolation ON lms_courses
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_enrollments
ALTER TABLE lms_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_enrollments_ws_isolation ON lms_enrollments;
CREATE POLICY lms_enrollments_ws_isolation ON lms_enrollments
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_lesson_progress
ALTER TABLE lms_lesson_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_lesson_progress_ws_isolation ON lms_lesson_progress;
CREATE POLICY lms_lesson_progress_ws_isolation ON lms_lesson_progress
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_lessons
ALTER TABLE lms_lessons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_lessons_ws_isolation ON lms_lessons;
CREATE POLICY lms_lessons_ws_isolation ON lms_lessons
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_modules
ALTER TABLE lms_modules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_modules_ws_isolation ON lms_modules;
CREATE POLICY lms_modules_ws_isolation ON lms_modules
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- lms_tracks
ALTER TABLE lms_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lms_tracks_ws_isolation ON lms_tracks;
CREATE POLICY lms_tracks_ws_isolation ON lms_tracks
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- ogiam_action_outcomes
ALTER TABLE ogiam_action_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ogiam_action_outcomes_ws_isolation ON ogiam_action_outcomes;
CREATE POLICY ogiam_action_outcomes_ws_isolation ON ogiam_action_outcomes
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- ogiam_checkpoints
ALTER TABLE ogiam_checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ogiam_checkpoints_ws_isolation ON ogiam_checkpoints;
CREATE POLICY ogiam_checkpoints_ws_isolation ON ogiam_checkpoints
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- ogiam_decisions
ALTER TABLE ogiam_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ogiam_decisions_ws_isolation ON ogiam_decisions;
CREATE POLICY ogiam_decisions_ws_isolation ON ogiam_decisions
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');


-- Assertion: every listed table now has RLS enabled, the workspace policy, no
-- permissive USING (true) policy left beside it, and NO FORCE (FORCE would make
-- the owner connection the app uses today subject to the policy = outage).
DO $$
DECLARE
  t TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'ai_spend_baseline',
    'instinct_agent_baselines',
    'instinct_agent_blocked_fingerprints',
    'instinct_agent_connections',
    'instinct_agent_containment',
    'instinct_agent_drift_events',
    'instinct_agent_memory',
    'instinct_agent_model_regressions',
    'instinct_agent_operations',
    'instinct_agent_operator_blocklist',
    'instinct_agent_pending_approvals',
    'instinct_agent_run_spend',
    'instinct_agent_scans',
    'instinct_agent_screenshots',
    'instinct_agent_sightings',
    'instinct_agent_tasks',
    'instinct_agents',
    'instinct_code_gate_policy',
    'instinct_document_recognitions',
    'instinct_factory_corrections',
    'instinct_factory_exemplars',
    'instinct_factory_failure_memory',
    'instinct_factory_memory_provenance',
    'instinct_factory_repair_recipes',
    'instinct_factory_reuse_corpus',
    'instinct_forcefield_canaries',
    'instinct_hr_scanned_documents',
    'instinct_invoices',
    'instinct_job_codes_edits',
    'instinct_learned_hostile_signatures',
    'instinct_mcp_manifest_pins',
    'instinct_meeting_insights',
    'instinct_meeting_prep_signals',
    'instinct_operator_reputation',
    'instinct_receipt_scans',
    'instinct_reputation_optin',
    'instinct_scan_anomaly_runs',
    'instinct_scan_host_baseline',
    'instinct_sharepoint_sources',
    'instinct_site_acceptance',
    'instinct_site_acceptance_runs',
    'instinct_site_finding_triage',
    'instinct_spec_diff_runs',
    'instinct_time_entries',
    'instinct_user_feedback',
    'instinct_walked_system_maps',
    'instinct_workspace_model_keys',
    'instinct_workspace_offboarding_log',
    'lms_courses',
    'lms_enrollments',
    'lms_lesson_progress',
    'lms_lessons',
    'lms_modules',
    'lms_tracks',
    'ogiam_action_outcomes',
    'ogiam_checkpoints',
    'ogiam_decisions'
  ];
BEGIN
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = t AND n.nspname = current_schema() AND c.relkind = 'r'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'migration 297: % is not RLS-enabled without FORCE', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = t AND p.polname = t || '_ws_isolation'
    ) THEN
      RAISE EXCEPTION 'migration 297: % has no workspace policy', t;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = t AND pg_get_expr(p.polqual, p.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'migration 297: % still has a permissive USING (true) policy', t;
    END IF;
  END LOOP;
END $$;
