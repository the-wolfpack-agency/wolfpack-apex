-- Down for migration 297: drop the workspace policies and disable RLS on the
-- tables 297 enabled it on, which is exactly their state before 297. No data is
-- touched. Idempotent.

DROP POLICY IF EXISTS ai_spend_baseline_ws_isolation ON ai_spend_baseline;
ALTER TABLE ai_spend_baseline DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_baselines_ws_isolation ON instinct_agent_baselines;
ALTER TABLE instinct_agent_baselines DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_blocked_fingerprints_ws_isolation ON instinct_agent_blocked_fingerprints;
ALTER TABLE instinct_agent_blocked_fingerprints DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_connections_ws_isolation ON instinct_agent_connections;
ALTER TABLE instinct_agent_connections DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_containment_ws_isolation ON instinct_agent_containment;
ALTER TABLE instinct_agent_containment DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_drift_events_ws_isolation ON instinct_agent_drift_events;
ALTER TABLE instinct_agent_drift_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_memory_ws_isolation ON instinct_agent_memory;
ALTER TABLE instinct_agent_memory DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_model_regressions_ws_isolation ON instinct_agent_model_regressions;
ALTER TABLE instinct_agent_model_regressions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_operations_ws_isolation ON instinct_agent_operations;
ALTER TABLE instinct_agent_operations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_operator_blocklist_ws_isolation ON instinct_agent_operator_blocklist;
ALTER TABLE instinct_agent_operator_blocklist DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_pending_approvals_ws_isolation ON instinct_agent_pending_approvals;
ALTER TABLE instinct_agent_pending_approvals DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_run_spend_ws_isolation ON instinct_agent_run_spend;
ALTER TABLE instinct_agent_run_spend DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_scans_ws_isolation ON instinct_agent_scans;
ALTER TABLE instinct_agent_scans DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_screenshots_ws_isolation ON instinct_agent_screenshots;
ALTER TABLE instinct_agent_screenshots DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_sightings_ws_isolation ON instinct_agent_sightings;
ALTER TABLE instinct_agent_sightings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agent_tasks_ws_isolation ON instinct_agent_tasks;
ALTER TABLE instinct_agent_tasks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_agents_ws_isolation ON instinct_agents;
ALTER TABLE instinct_agents DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_code_gate_policy_ws_isolation ON instinct_code_gate_policy;
ALTER TABLE instinct_code_gate_policy DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_document_recognitions_ws_isolation ON instinct_document_recognitions;
ALTER TABLE instinct_document_recognitions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_corrections_ws_isolation ON instinct_factory_corrections;
ALTER TABLE instinct_factory_corrections DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_exemplars_ws_isolation ON instinct_factory_exemplars;
ALTER TABLE instinct_factory_exemplars DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_failure_memory_ws_isolation ON instinct_factory_failure_memory;
ALTER TABLE instinct_factory_failure_memory DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_memory_provenance_ws_isolation ON instinct_factory_memory_provenance;
ALTER TABLE instinct_factory_memory_provenance DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_repair_recipes_ws_isolation ON instinct_factory_repair_recipes;
ALTER TABLE instinct_factory_repair_recipes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_factory_reuse_corpus_ws_isolation ON instinct_factory_reuse_corpus;
ALTER TABLE instinct_factory_reuse_corpus DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_forcefield_canaries_ws_isolation ON instinct_forcefield_canaries;
ALTER TABLE instinct_forcefield_canaries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_hr_scanned_documents_ws_isolation ON instinct_hr_scanned_documents;
ALTER TABLE instinct_hr_scanned_documents DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_invoices_ws_isolation ON instinct_invoices;
ALTER TABLE instinct_invoices DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_job_codes_edits_ws_isolation ON instinct_job_codes_edits;
ALTER TABLE instinct_job_codes_edits DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_learned_hostile_signatures_ws_isolation ON instinct_learned_hostile_signatures;
ALTER TABLE instinct_learned_hostile_signatures DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_mcp_manifest_pins_ws_isolation ON instinct_mcp_manifest_pins;
ALTER TABLE instinct_mcp_manifest_pins DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_meeting_insights_ws_isolation ON instinct_meeting_insights;
ALTER TABLE instinct_meeting_insights DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_meeting_prep_signals_ws_isolation ON instinct_meeting_prep_signals;
ALTER TABLE instinct_meeting_prep_signals DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_operator_reputation_ws_isolation ON instinct_operator_reputation;
ALTER TABLE instinct_operator_reputation DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_receipt_scans_ws_isolation ON instinct_receipt_scans;
ALTER TABLE instinct_receipt_scans DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_reputation_optin_ws_isolation ON instinct_reputation_optin;
ALTER TABLE instinct_reputation_optin DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_scan_anomaly_runs_ws_isolation ON instinct_scan_anomaly_runs;
ALTER TABLE instinct_scan_anomaly_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_scan_host_baseline_ws_isolation ON instinct_scan_host_baseline;
ALTER TABLE instinct_scan_host_baseline DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_sharepoint_sources_ws_isolation ON instinct_sharepoint_sources;
ALTER TABLE instinct_sharepoint_sources DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_site_acceptance_ws_isolation ON instinct_site_acceptance;
ALTER TABLE instinct_site_acceptance DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_site_acceptance_runs_ws_isolation ON instinct_site_acceptance_runs;
ALTER TABLE instinct_site_acceptance_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_site_finding_triage_ws_isolation ON instinct_site_finding_triage;
ALTER TABLE instinct_site_finding_triage DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_spec_diff_runs_ws_isolation ON instinct_spec_diff_runs;
ALTER TABLE instinct_spec_diff_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_time_entries_ws_isolation ON instinct_time_entries;
ALTER TABLE instinct_time_entries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_user_feedback_ws_isolation ON instinct_user_feedback;
ALTER TABLE instinct_user_feedback DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_walked_system_maps_ws_isolation ON instinct_walked_system_maps;
ALTER TABLE instinct_walked_system_maps DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_workspace_model_keys_ws_isolation ON instinct_workspace_model_keys;
ALTER TABLE instinct_workspace_model_keys DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_workspace_offboarding_log_ws_isolation ON instinct_workspace_offboarding_log;
ALTER TABLE instinct_workspace_offboarding_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_courses_ws_isolation ON lms_courses;
ALTER TABLE lms_courses DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_enrollments_ws_isolation ON lms_enrollments;
ALTER TABLE lms_enrollments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_lesson_progress_ws_isolation ON lms_lesson_progress;
ALTER TABLE lms_lesson_progress DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_lessons_ws_isolation ON lms_lessons;
ALTER TABLE lms_lessons DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_modules_ws_isolation ON lms_modules;
ALTER TABLE lms_modules DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_tracks_ws_isolation ON lms_tracks;
ALTER TABLE lms_tracks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ogiam_action_outcomes_ws_isolation ON ogiam_action_outcomes;
ALTER TABLE ogiam_action_outcomes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ogiam_checkpoints_ws_isolation ON ogiam_checkpoints;
ALTER TABLE ogiam_checkpoints DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ogiam_decisions_ws_isolation ON ogiam_decisions;
ALTER TABLE ogiam_decisions DISABLE ROW LEVEL SECURITY;

