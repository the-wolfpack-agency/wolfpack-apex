/**
 * Storage helpers for per-workspace GitHub App installations
 * (table github_app_installations, migration 195).
 *
 * link / remove / get. Mutations fire the registered analytics events
 * (platform.github_installation_linked / _removed) so the linking of a client's
 * repos is captured in the learning loop. Reads degrade to null in shadow mode
 * (no DATABASE_URL) so resolveGithubToken cleanly falls back to the PAT.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface GithubInstallation {
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  linkedAt: string;
  linkedBy: string;
}

interface InstallationRow extends Record<string, unknown> {
  workspace_id: string;
  installation_id: string;
  account_login: string | null;
  linked_at: string | Date;
  linked_by: string;
}

function rowToInstallation(row: InstallationRow): GithubInstallation {
  return {
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    accountLogin: row.account_login ?? null,
    linkedAt:
      row.linked_at instanceof Date ? row.linked_at.toISOString() : String(row.linked_at),
    linkedBy: row.linked_by,
  };
}

/**
 * Look up the installation linked to a workspace. Returns null when none is
 * linked or in shadow mode. NEVER throws (safeQuery swallows DB errors) so the
 * token resolver can always fall back to the PAT.
 */
export async function getInstallation(
  workspaceId: string,
): Promise<GithubInstallation | null> {
  const { rows } = await safeQuery<InstallationRow>(
    `SELECT workspace_id, installation_id, account_login, linked_at, linked_by
       FROM github_app_installations
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length === 0) return null;
  return rowToInstallation(rows[0]);
}

export interface LinkInstallationInput {
  workspaceId: string;
  installationId: string;
  accountLogin?: string | null;
  linkedBy: string;
  actorRole?: string;
}

/**
 * Link (or re-link) an installation to a workspace. Upserts on workspace_id so
 * re-installing overwrites cleanly. Fires platform.github_installation_linked.
 */
export async function linkInstallation(
  input: LinkInstallationInput,
): Promise<GithubInstallation> {
  const { rows } = await writeQuery<InstallationRow>(
    `INSERT INTO github_app_installations
       (workspace_id, installation_id, account_login, linked_by, linked_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (workspace_id) DO UPDATE
       SET installation_id = EXCLUDED.installation_id,
           account_login   = EXCLUDED.account_login,
           linked_by       = EXCLUDED.linked_by,
           linked_at       = NOW()
     RETURNING workspace_id, installation_id, account_login, linked_at, linked_by`,
    [input.workspaceId, input.installationId, input.accountLogin ?? null, input.linkedBy],
    { expectRows: 1 },
  );
  const installation = rowToInstallation(rows[0]);
  trackEvent(
    "platform.github_installation_linked",
    input.linkedBy,
    input.actorRole ?? "system",
    {
      workspace_id: installation.workspaceId,
      installation_id: installation.installationId,
      account_login: installation.accountLogin ?? "",
    },
  );
  return installation;
}

export interface RemoveInstallationInput {
  workspaceId: string;
  removedBy: string;
  actorRole?: string;
}

/**
 * Remove the installation linked to a workspace. Idempotent: returns false when
 * there was nothing to remove. Fires platform.github_installation_removed only
 * when a row actually existed.
 */
export async function removeInstallation(
  input: RemoveInstallationInput,
): Promise<boolean> {
  const { rows } = await writeQuery<{ installation_id: string }>(
    `DELETE FROM github_app_installations
      WHERE workspace_id = $1
      RETURNING installation_id`,
    [input.workspaceId],
  );
  if (rows.length === 0) return false;
  trackEvent(
    "platform.github_installation_removed",
    input.removedBy,
    input.actorRole ?? "system",
    {
      workspace_id: input.workspaceId,
      installation_id: rows[0].installation_id,
    },
  );
  return true;
}
