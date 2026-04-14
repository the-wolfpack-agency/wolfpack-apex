-- Migration 014: Instinct table aliases (Phase 1 of apex_ -> instinct_ rename)
--
-- Phase 1: Create views with instinct_ prefixes pointing to existing apex_ tables.
-- This lets new code start using instinct_* names immediately while existing
-- queries continue to work against the original apex_* tables unchanged.
--
-- Phase 2 (future): Once all queries are migrated to instinct_* names, rename
-- the underlying tables and flip the views so apex_* becomes the alias.

-- Foundation tables (001)
CREATE OR REPLACE VIEW instinct_team_members AS SELECT * FROM apex_team_members;
CREATE OR REPLACE VIEW instinct_clients AS SELECT * FROM apex_clients;
CREATE OR REPLACE VIEW instinct_documents AS SELECT * FROM apex_documents;
CREATE OR REPLACE VIEW instinct_knowledge AS SELECT * FROM apex_knowledge;
CREATE OR REPLACE VIEW instinct_conversations AS SELECT * FROM apex_conversations;
CREATE OR REPLACE VIEW instinct_messages AS SELECT * FROM apex_messages;
CREATE OR REPLACE VIEW instinct_events AS SELECT * FROM apex_events;
CREATE OR REPLACE VIEW instinct_prototypes AS SELECT * FROM apex_prototypes;
CREATE OR REPLACE VIEW instinct_feature_requests AS SELECT * FROM apex_feature_requests;
CREATE OR REPLACE VIEW instinct_journals AS SELECT * FROM apex_journals;
CREATE OR REPLACE VIEW instinct_discussions AS SELECT * FROM apex_discussions;
CREATE OR REPLACE VIEW instinct_discussion_replies AS SELECT * FROM apex_discussion_replies;

-- Assistant memory (003)
CREATE OR REPLACE VIEW instinct_user_memory AS SELECT * FROM apex_user_memory;

-- QuickBooks (004)
CREATE OR REPLACE VIEW instinct_qbo_tokens AS SELECT * FROM apex_qbo_tokens;

-- Microsoft Graph (005, 006)
CREATE OR REPLACE VIEW instinct_ms_tokens AS SELECT * FROM apex_ms_tokens;

-- Meeting transcripts (005)
CREATE OR REPLACE VIEW instinct_meeting_transcripts AS SELECT * FROM apex_meeting_transcripts;

-- Plaud (007)
CREATE OR REPLACE VIEW instinct_plaud_connections AS SELECT * FROM apex_plaud_connections;

-- Sites (009)
CREATE OR REPLACE VIEW instinct_site_projects AS SELECT * FROM apex_site_projects;
CREATE OR REPLACE VIEW instinct_site_assets AS SELECT * FROM apex_site_assets;
CREATE OR REPLACE VIEW instinct_site_deploys AS SELECT * FROM apex_site_deploys;

-- People / Employees (010)
CREATE OR REPLACE VIEW instinct_employees AS SELECT * FROM apex_employees;

-- HR (010, 011, 012)
CREATE OR REPLACE VIEW instinct_benefit_plans AS SELECT * FROM apex_benefit_plans;
CREATE OR REPLACE VIEW instinct_benefit_documents AS SELECT * FROM apex_benefit_documents;
CREATE OR REPLACE VIEW instinct_benefit_recommendations AS SELECT * FROM apex_benefit_recommendations;
CREATE OR REPLACE VIEW instinct_hr_insights AS SELECT * FROM apex_hr_insights;
CREATE OR REPLACE VIEW instinct_hr_documents AS SELECT * FROM apex_hr_documents;

-- Onboarding (013)
CREATE OR REPLACE VIEW instinct_onboarding_templates AS SELECT * FROM apex_onboarding_templates;
CREATE OR REPLACE VIEW instinct_onboarding_instances AS SELECT * FROM apex_onboarding_instances;
