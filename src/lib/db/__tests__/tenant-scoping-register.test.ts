/**
 * Every table declares whether it is tenant-scoped.
 *
 * THE ARCHITECTURE THIS ASSUMES (decided 2026-08-02)
 *
 * Instinct is sold as a product, and each client gets THEIR OWN DATABASE. A
 * client's data never shares a database with another client's, so the boundary
 * between companies is the database itself, not a predicate in a query.
 *
 * That decision is what this file is about, and it changes what this test
 * means. An earlier version of this header said a missing workspace_id becomes
 * exploitable "the day a second company runs it". Under one-database-per-client
 * that is no longer true, and leaving it would have made this guardrail assert
 * a threat model that had been ruled out — which is precisely the kind of
 * confidently-wrong control the rest of this work has been removing.
 *
 * WHAT THE REGISTER IS STILL FOR
 *
 * Two things, both weaker than the original claim and both real:
 *
 *   1. Intra-company separation. One client company can run several workspaces
 *      (teams, departments, brands). workspace_id is what keeps those apart
 *      INSIDE their own database, and 53 tables already rely on it. A new table
 *      without it silently opts out of that.
 *
 *   2. Drift. A table that HAS workspace_id must not quietly lose it and fall
 *      off the tenant-isolation scan's radar, which only checks tables that
 *      have the column. That scan cannot see this class of change; this can.
 *
 * WHAT IS NO LONGER CLAIMED
 *
 * The 149 tables are not a cross-company exposure and not a migration
 * programme. Under separate databases they are correct as they are. The count
 * below is inventory, not debt, and it is not expected to reach zero.
 *
 * WHAT THE ARCHITECTURE MOVES THE RISK TO
 *
 * Recorded here because it is the thing to get right, and it is not obvious
 * from the code:
 *
 *   - Tenant resolution must be UN-SPOOFABLE. The database a request uses has
 *     to be derived from the authenticated session claim, never from a
 *     subdomain, header or body field the caller controls. That is the one way
 *     this architecture fails as badly as a shared database would.
 *   - Migration fan-out must be resumable and report per-client status. N
 *     databases means a failure on client seven leaves the estate split-brain.
 *   - Connection limits. One pool per tenant inside a serverless function will
 *     exhaust Neon's per-project cap; pools need to be lazy and bounded.
 *
 * There is exactly one `new Pool()` in this codebase (src/lib/db.ts), so the
 * routing change is contained to one file and none of the 353 query sites move.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "db", "migrations");

/**
 * Tables with no workspace_id column, as of 2026-08-02.
 *
 * Inventory, not debt. Under one-database-per-client these are correct as they
 * are; the list exists so that adding to it is a decision rather than an
 * accident, and so a reviewer can see WHICH tables without running anything.
 */
const NO_WORKSPACE_COLUMN: readonly string[] = [
  "apex_benefit_documents",
  "apex_benefit_plans",
  "apex_benefit_recommendations",
  "apex_brief_edit_insights_snapshots",
  "apex_clients",
  "apex_conversations",
  "apex_discussion_replies",
  "apex_discussions",
  "apex_documents",
  "apex_employees",
  "apex_events",
  "apex_feature_requests",
  "apex_hr_documents",
  "apex_hr_insights",
  "apex_journals",
  "apex_knowledge",
  "apex_meeting_transcripts",
  "apex_messages",
  "apex_ms_tokens",
  "apex_onboarding_instances",
  "apex_onboarding_templates",
  "apex_plaud_connections",
  "apex_prototypes",
  "apex_qbo_tokens",
  "apex_share_tokens",
  "apex_site_approvals",
  "apex_site_assets",
  "apex_site_brief_edits",
  "apex_site_brief_generations",
  "apex_site_deploys",
  "apex_site_domains",
  "apex_site_form_submissions",
  "apex_site_image_generations",
  "apex_site_projects",
  "apex_team_members",
  "apex_user_memory",
  "brain_chunks",
  "brain_documents",
  "brain_jobs",
  "brain_query_log",
  "chat_read_state",
  "instinct_agent_principals",
  "instinct_audit_chain_anchors",
  "instinct_audit_log",
  "instinct_automation_audit_actions",
  "instinct_automation_porsche_artifacts",
  "instinct_automation_porsche_config",
  "instinct_automation_porsche_deltas",
  "instinct_automation_porsche_exceptions",
  "instinct_automation_porsche_notifications",
  "instinct_automation_porsche_overrides",
  "instinct_automation_porsche_poll_state",
  "instinct_automation_porsche_snapshots",
  "instinct_azure_calls",
  "instinct_benchmark_runs",
  "instinct_bulletin_boards",
  "instinct_bulletin_notes",
  "instinct_bulletin_snapshots",
  "instinct_calendar_events_written",
  "instinct_client_asset_blobs",
  "instinct_client_assets",
  "instinct_company_krs",
  "instinct_company_okrs",
  "instinct_competitor_benchmark_runs",
  "instinct_contacts_mirror",
  "instinct_contributions",
  "instinct_directory_users",
  "instinct_email_signatures",
  "instinct_engineering_pages",
  "instinct_entity_links",
  "instinct_entity_tags",
  "instinct_feedback_screenshot",
  "instinct_gate_rate_limits",
  "instinct_groups",
  "instinct_invoice_tracker_cache",
  "instinct_job_codes_cache",
  "instinct_job_codes_refresh",
  "instinct_mailbox_ooo_state",
  "instinct_meeting_analyses",
  "instinct_meeting_artifacts",
  "instinct_meeting_attachments",
  "instinct_meeting_exceptions",
  "instinct_meeting_feeds",
  "instinct_meeting_messages",
  "instinct_ms_change_log",
  "instinct_ms_contacts",
  "instinct_ms_events",
  "instinct_ms_files",
  "instinct_ms_files_metadata",
  "instinct_ms_messages",
  "instinct_ms_sync_cursors",
  "instinct_ms_sync_state",
  "instinct_ms_tasks",
  "instinct_north_star_snapshots",
  "instinct_notification_preferences",
  "instinct_notifications",
  "instinct_onenote_pages",
  "instinct_online_meetings",
  "instinct_org_facts",
  "instinct_password_resets",
  "instinct_pending_actions",
  "instinct_people_suggestions_cache",
  "instinct_planner_buckets",
  "instinct_planner_plans",
  "instinct_planner_tasks",
  "instinct_principle_doc_versions",
  "instinct_principle_evidence_views",
  "instinct_principle_observations",
  "instinct_principle_signals",
  "instinct_principle_weekly_doc_uploads",
  "instinct_principle_weekly_reports",
  "instinct_principles",
  "instinct_principles_config",
  "instinct_program_budget_actuals",
  "instinct_program_budget_categories",
  "instinct_program_budget_lines",
  "instinct_program_budgets",
  "instinct_qr_codes",
  "instinct_qr_scans",
  "instinct_refresh_tokens",
  "instinct_release_gate_notifications",
  "instinct_releases",
  "instinct_sent_mail",
  "instinct_setup_events",
  "instinct_sharepoint_ingest_jobs",
  "instinct_site_section_comments",
  "instinct_support_patterns",
  "instinct_support_poll_state",
  "instinct_support_response_cache",
  "instinct_support_ticket_messages",
  "instinct_support_tickets",
  "instinct_survey_responses",
  "instinct_survey_views",
  "instinct_surveys",
  "instinct_sweep_runs",
  "instinct_task_lists",
  "instinct_tasks",
  "instinct_teams_channel_messages",
  "instinct_teams_channels",
  "instinct_teams_chats",
  "instinct_teams_messages",
  "instinct_teams_teams",
  "instinct_tenant_isolation_scans",
  "instinct_user_nav_prefs",
  "instinct_workspace",
  "integration_templates",
  "knowledge_qa_entries",
  "mailbox_poll_cursors",
  "site_analytics_events",
];

/** Read every table and its columns out of the migrations. */
export function tableColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const add = (t: string, c: string) => {
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t)!.add(c);
  };

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.includes(".down.")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf-8");
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const col of m[2].matchAll(/^\s*(\w+)\s+/gm)) add(m[1], col[1]);
    }
    // A column added later counts: several tables gained workspace_id this way.
    for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)) {
      add(m[1], m[2]);
    }
  }
  return tables;
}

describe("every table declares whether it is tenant-scoped", () => {
  const tables = tableColumns();
  const unscoped = [...tables.entries()]
    .filter(([, cols]) => !cols.has("workspace_id"))
    .map(([t]) => t)
    .sort();

  it("reads the schema, so a broken parse cannot pass by finding nothing", () => {
    // A scanner that silently matches zero tables reports success forever.
    expect(tables.size).toBeGreaterThan(150);
  });

  it("has no NEW table without a workspace_id column", () => {
    const added = unscoped.filter((t) => !NO_WORKSPACE_COLUMN.includes(t));
    expect({
      hint: "Does this table need to be separated per WORKSPACE inside one client's database? If yes it needs workspace_id. If it is instance-wide, add it to NO_WORKSPACE_COLUMN on purpose. Cross-CLIENT separation is handled by the database, not this column.",
      added,
    }).toEqual({ hint: expect.any(String), added: [] });
  });

  it("has no stale entry, so the register cannot overstate the debt", () => {
    const fixed = NO_WORKSPACE_COLUMN.filter((t) => !unscoped.includes(t));
    expect({ hint: "Now scoped, or removed. Delete it from NO_WORKSPACE_COLUMN.", fixed }).toEqual({
      hint: expect.any(String),
      fixed: [],
    });
  });

  it("records the count, so a change to it is deliberate", () => {
    // Not a debt figure and not expected to reach zero. It moves when someone
    // decides a table is instance-wide, and that decision should be visible in
    // a diff rather than inferred later.
    expect(NO_WORKSPACE_COLUMN.length).toBe(149);
  });

  it("keeps the tables that ARE scoped scoped", () => {
    // The other half of the guarantee: a table cannot quietly LOSE its
    // workspace_id and drop off the tenant-isolation scan's radar.
    const scoped = [...tables.entries()].filter(([, c]) => c.has("workspace_id"));
    expect(scoped.length).toBeGreaterThanOrEqual(50);
  });
});
