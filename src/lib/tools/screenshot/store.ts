/**
 * Persist and read agent/tool screenshots (migration 220,
 * instinct_agent_screenshots). Base64 in Postgres, mirroring the feedback
 * screenshot store. Only PNG is produced by the capture engine, so there is no
 * SVG/script vector; the serving route still sends nosniff + a strict CSP.
 */

import { writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/** Ceiling on a stored PNG. A full-page 1280px capture is typically < 2 MB;
 *  base64 inflates ~33%, so the TEXT row stays a few MB at most. */
export const MAX_SCREENSHOT_BYTES = 6_000_000;

export interface StoreScreenshotInput {
  workspaceId: string;
  createdBy: string;
  sourceUrl: string;
  png: Buffer;
}

export interface StoredScreenshot {
  contentType: string;
  dataBase64: string;
  byteSize: number;
}

export async function storeScreenshot(
  input: StoreScreenshotInput,
): Promise<{ id: string; byteSize: number }> {
  const byteSize = input.png.length;
  const dataBase64 = input.png.toString("base64");
  const { rows } = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_agent_screenshots
       (workspace_id, created_by, source_url, content_type, data_base64, byte_size)
     VALUES ($1, $2, $3, 'image/png', $4, $5)
     RETURNING id`,
    [input.workspaceId, input.createdBy, input.sourceUrl, dataBase64, byteSize],
    { expectRows: 1 },
  );
  trackEvent("tools.screenshot_captured", input.createdBy, "system", {
    workspace_id: input.workspaceId,
    source_url: input.sourceUrl,
    byte_size: byteSize,
  });
  return { id: rows[0].id, byteSize };
}

/** Workspace-scoped read; returns null across tenants (no existence leak). */
export async function getScreenshot(
  id: string,
  workspaceId: string,
): Promise<StoredScreenshot | null> {
  const res = await safeQuery<{ content_type: string; data_base64: string; byte_size: number }>(
    `SELECT content_type, data_base64, byte_size
       FROM instinct_agent_screenshots
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    contentType: row.content_type,
    dataBase64: row.data_base64,
    byteSize: row.byte_size,
  };
}
