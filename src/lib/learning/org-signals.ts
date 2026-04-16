/**
 * Org signals — reporting chain, team inference, headcount metrics.
 *
 * All derived from `instinct_directory_users` which is populated by the
 * delta sync in microsoft-directory.ts. No Graph round-trips on the hot
 * path — the Assistant and analytics brain can call these freely.
 *
 * Also provides a RAG indexer (`indexDirectoryUser`) which mirrors the
 * `saveAnswer` pattern used for Teams / OneNote so "who handles X" lookups
 * against the Assistant's knowledge base return relevant people.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { safeQuery } from "@/lib/db";
import { saveAnswer } from "@/lib/knowledge";
import type { DirectoryUser } from "@/lib/integrations/microsoft-directory";

// ---------------------------------------------------------------------------
// Reporting chain
// ---------------------------------------------------------------------------

/**
 * Walk manager_ms_id upward until we hit null (top of org) or a cycle.
 * Returns ms_user_id values in order from subject (index 0) upward.
 */
export async function getReportingChain(msUserId: string, maxDepth = 20): Promise<string[]> {
  const out: string[] = [msUserId];
  const seen = new Set<string>([msUserId]);
  let cursor: string | null = msUserId;

  for (let i = 0; i < maxDepth; i++) {
    const result: { rows: Array<{ manager_ms_id: string | null }> } =
      await safeQuery<{ manager_ms_id: string | null }>(
        `SELECT manager_ms_id FROM instinct_directory_users
          WHERE ms_user_id = $1 LIMIT 1`,
        [cursor],
      );
    if (result.rows.length === 0) break;
    const mgr: string | null = result.rows[0].manager_ms_id;
    if (!mgr || seen.has(mgr)) break;
    out.push(mgr);
    seen.add(mgr);
    cursor = mgr;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Team inference
// ---------------------------------------------------------------------------

/**
 * Team = people in the same department plus anyone in the reporting chain
 * up to and including the subject's skip-level manager. Returns
 * ms_user_id values (deduplicated).
 */
export async function getTeamsForUser(msUserId: string): Promise<string[]> {
  const { rows: subjectRows } = await safeQuery<{ department: string | null; manager_ms_id: string | null }>(
    `SELECT department, manager_ms_id FROM instinct_directory_users
      WHERE ms_user_id = $1 LIMIT 1`,
    [msUserId],
  );
  if (subjectRows.length === 0) return [];
  const department = subjectRows[0].department;
  const managerMsId = subjectRows[0].manager_ms_id;

  const collected = new Set<string>([msUserId]);

  if (department) {
    const { rows } = await safeQuery<{ ms_user_id: string }>(
      `SELECT ms_user_id FROM instinct_directory_users
        WHERE department = $1 AND account_enabled = true`,
      [department],
    );
    for (const r of rows) collected.add(r.ms_user_id);
  }

  // Add manager + skip-level.
  const chain = await getReportingChain(msUserId, 2);
  for (const id of chain) collected.add(id);
  // Sibling inference via shared manager.
  if (managerMsId) {
    const { rows } = await safeQuery<{ ms_user_id: string }>(
      `SELECT ms_user_id FROM instinct_directory_users
        WHERE manager_ms_id = $1 AND account_enabled = true`,
      [managerMsId],
    );
    for (const r of rows) collected.add(r.ms_user_id);
  }

  return [...collected];
}

// ---------------------------------------------------------------------------
// Headcount / org size
// ---------------------------------------------------------------------------

export interface DepartmentHeadcount {
  department: string;
  count: number;
}

export async function getOrgSizeMetrics(): Promise<{
  total: number;
  byDepartment: DepartmentHeadcount[];
}> {
  const { rows: tot } = await safeQuery<{ count: string }>(
    `SELECT count(*)::text AS count FROM instinct_directory_users
      WHERE account_enabled = true`,
  );
  const total = Number(tot[0]?.count ?? 0);

  const { rows: dep } = await safeQuery<{ department: string | null; count: string }>(
    `SELECT department, count(*)::text AS count
       FROM instinct_directory_users
      WHERE account_enabled = true
      GROUP BY department
      ORDER BY count DESC`,
  );
  const byDepartment: DepartmentHeadcount[] = dep.map((r) => ({
    department: r.department ?? "Unassigned",
    count: Number(r.count),
  }));

  return { total, byDepartment };
}

// ---------------------------------------------------------------------------
// RAG hookup — index each directory user for "who handles X" Assistant hits
// ---------------------------------------------------------------------------

/**
 * Index a directory user into the Assistant RAG via saveAnswer. The
 * "question" is a synthesized lookup string so trigram search hits on
 * role + department + name. Indexing failures bubble so the caller can
 * keep its sync counting distinct. Mirrors learning/ms-content-ingest.ts.
 */
export async function indexDirectoryUser(
  userId: string,
  user: DirectoryUser,
): Promise<void> {
  const parts = [user.displayName, user.jobTitle, user.department].filter(Boolean);
  if (parts.length === 0) return;
  const question = `Who handles ${user.jobTitle ?? "this role"}${user.department ? ` in ${user.department}` : ""}?`;
  const answer = `${user.displayName ?? user.userPrincipalName ?? user.mail ?? "Unknown"}${
    user.jobTitle ? ` — ${user.jobTitle}` : ""
  }${user.department ? ` (${user.department})` : ""}${user.mail ? `\nContact: ${user.mail}` : ""}`;

  const entry = await saveAnswer(
    question,
    answer,
    "directory_user",
    userId,
    undefined,
    undefined,
    0,
  );
  if (!entry) {
    throw new Error(`saveAnswer returned null for directory user ${user.msUserId}`);
  }
}
