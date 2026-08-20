/**
 * Every table declares whether it is tenant-scoped.
 *
 * WHY THIS IS THE GAP THAT MATTERS NOW
 *
 * Instinct is becoming a product other companies run. The repo already has a
 * strong tenant-isolation scan, and it validates 53 workspace-scoped tables
 * rigorously: every query must carry a visible workspace_id predicate, and
 * unclassified must be zero.
 *
 * It is structurally blind to the rest. A table with NO workspace_id column
 * cannot fail a scan that checks for a workspace_id predicate — there is
 * nothing to check. So 149 of 202 tables are invisible to it, and the scan
 * reports clean while they sit in one global namespace.
 *
 * That is the same shape as every other finding in this codebase: a control
 * that reports success because it is incapable of reporting anything else.
 *
 * WHAT IS AND IS NOT TRUE TODAY
 *
 * Not exploitable. Instinct runs single-tenant, so one namespace is the
 * correct namespace and nothing is currently exposed to anyone.
 *
 * It becomes exploitable on the day a second company runs it. Found while
 * tracing a real one: /api/clients/[id]/assets/[assetId]/raw serves asset
 * BYTES, and getAssetById() looks the row up by id alone. The route checks the
 * asset belongs to the client slug in the path and never that the client
 * belongs to the caller. With one tenant that is fine. With two it is a
 * document disclosure.
 *
 * WHAT THIS TEST DOES, AND DELIBERATELY DOES NOT DO
 *
 * It does not fix 149 tables. That is a migration programme with backfills and
 * query changes, and pretending otherwise would be worse than saying so.
 *
 * It makes the debt COUNTABLE and stops it growing: a new table must carry
 * workspace_id or be added here on purpose, which is a decision someone makes
 * rather than a default they inherit. The list may only shrink, and a stale
 * entry fails too, so it cannot rot into permission.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "db", "migrations");

/**
 * Tables with no workspace_id column, as of 2026-08-02.
 *
 * Ordered by what is at stake if this platform is ever run by two companies:
 * credentials first, then personal data, then client work, then knowledge.
 * The count is the number to drive down; the names are so a reviewer can see
 * WHICH ones without running anything.
 */
/**
 * Tables that are global BY DESIGN, and are therefore not debt.
 *
 * Kept apart from NO_WORKSPACE_COLUMN, which is a backlog with a count that may
 * only fall. Putting a deliberately global table on that list forces the count
 * UP, and a ratchet that gets raised for good reasons is one that will be
 * raised for bad ones too, until the number stops meaning anything.
 *
 * The bar for this list is that per-workspace rows would be WRONG, not merely
 * unnecessary: two tenants must not be able to hold different beliefs about the
 * same external fact.
 */
const GLOBAL_BY_DESIGN: readonly string[] = [
  /* A model version is a fact about the PROVIDER, identical for every tenant.
     Two tenants disagreeing about what OpenAI shipped is not a disagreement
     that can be true. */
  "ai_model_versions",
];

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
    const added = unscoped.filter(
      (t) => !NO_WORKSPACE_COLUMN.includes(t) && !GLOBAL_BY_DESIGN.includes(t),
    );
    expect({
      hint: "A new table needs workspace_id to be safe when a second company runs this platform. If it is genuinely global reference data, add it to NO_WORKSPACE_COLUMN on purpose.",
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

  it("records the debt as a number, so the direction is visible", () => {
    // Update deliberately, downward. This is the metric that says whether
    // Instinct is ready to be run by someone else. Tables that are global by
    // design are counted separately, so this number only ever moves for the
    // reason it was created to track.
    expect(NO_WORKSPACE_COLUMN.length).toBe(149);
  });

  it("does not let the by-design list become a second backlog", () => {
    /* The escape hatch has to stay small enough to read in one go, or it turns
       into the thing it was built to keep honest. */
    expect(GLOBAL_BY_DESIGN.length).toBeLessThanOrEqual(5);
    for (const table of GLOBAL_BY_DESIGN) {
      expect(NO_WORKSPACE_COLUMN).not.toContain(table);
    }
  });

  it("keeps the tables that ARE scoped scoped", () => {
    // The other half of the guarantee: a table cannot quietly LOSE its
    // workspace_id and drop off the tenant-isolation scan's radar.
    const scoped = [...tables.entries()].filter(([, c]) => c.has("workspace_id"));
    expect(scoped.length).toBeGreaterThanOrEqual(50);
  });
});
