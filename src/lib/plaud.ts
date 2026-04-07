/**
 * Plaud (AI voice recorder) integration.
 *
 * Webhook-driven ingestion of meeting transcripts. Plaud calls our
 * webhook endpoint when a recording finishes transcribing; we verify
 * the HMAC signature, fetch the transcript via Plaud's API, run it
 * through the doc quality gate, and write to:
 *   - Postgres (apex_meeting_transcripts) — system of record
 *   - Qdrant   (via tripleWriteKnowledge)  — semantic search
 *   - Analytics (apex_events)              — learning loop
 *
 * Org-level scope (one shared connection for the team), but every
 * transcript is tagged with owner_user_id so we can switch to
 * per-user retrieval later without re-ingesting.
 *
 * Plaud webhook contract (from docs.plaud.ai):
 *   POST {our endpoint}
 *   Header:  Plaud-Signature: <hex HMAC-SHA256 of raw body bytes>
 *   Body:    { event_type: string, data: { file_id: string, ... } }
 *
 * Idempotency: Plaud may re-deliver. The unique index on file_id
 * makes the upsert path safe; re-delivery is a no-op + analytics event.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { checkDocQuality, type GateResult } from "@/lib/doc-quality-gate";
import { tripleWriteKnowledge } from "@/lib/triple-write";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaudWebhookPayload {
  event_type: string;
  data: {
    file_id: string;
    [k: string]: unknown;
  };
}

export interface PlaudTranscript {
  fileId: string;
  title?: string;
  transcript: string;
  summary?: string;
  recordedAt?: string;
  durationSeconds?: number;
  ownerEmail?: string;
}

export interface IngestResult {
  status: "ingested" | "duplicate" | "rejected" | "fetch_failed" | "no_owner";
  fileId: string;
  qualityStatus?: GateResult["verdict"];
  flags?: GateResult["flags"];
  ownerUserId?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLAUD_API_BASE_URL = process.env.PLAUD_API_BASE_URL || "https://api.plaud.ai";

function getWebhookSecret(): string {
  return process.env.PLAUD_WEBHOOK_SECRET || "";
}

function getApiKey(): string {
  return process.env.PLAUD_API_KEY || "";
}

export function isPlaudConfigured(): boolean {
  return Boolean(getWebhookSecret() && getApiKey());
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a Plaud webhook signature against the raw request body.
 * The signature MUST be computed against the unparsed bytes — JSON
 * round-tripping changes whitespace and breaks the HMAC. Use timing-safe
 * comparison to avoid leaking signature length via timing.
 */
export function verifyPlaudSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = getWebhookSecret();
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetching the transcript from Plaud
// ---------------------------------------------------------------------------

/**
 * Fetch a completed transcript from Plaud's API by file_id.
 *
 * NOTE: The exact endpoint shape (`/v1/files/:id`, `/api/files/:id`, etc.)
 * and auth header (Authorization: Bearer vs X-API-Key) will be confirmed
 * the first time we exercise this against a real Plaud account. Both
 * conventions are supported below — the response shape parsing is
 * tolerant of variation. If Plaud's actual schema diverges, only this
 * function needs to change.
 */
export async function fetchPlaudTranscript(fileId: string): Promise<PlaudTranscript | null> {
  if (!isPlaudConfigured()) return null;

  const url = `${PLAUD_API_BASE_URL}/v1/files/${encodeURIComponent(fileId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error(`[plaud] fetch transcript failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;

    // Tolerant field extraction — Plaud may return camelCase or snake_case
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) if (data[k] != null) return data[k];
      return undefined;
    };
    const transcript = (pick("transcript", "transcript_text", "text") as string) || "";
    if (!transcript) {
      console.error("[plaud] response had no transcript field");
      return null;
    }
    return {
      fileId,
      title: pick("title", "name") as string | undefined,
      transcript,
      summary: pick("summary", "ai_summary") as string | undefined,
      recordedAt: pick("recorded_at", "recordedAt", "created_at") as string | undefined,
      durationSeconds: pick("duration_seconds", "durationSeconds", "duration") as number | undefined,
      ownerEmail: pick("owner_email", "ownerEmail", "user_email") as string | undefined,
    };
  } catch (err) {
    console.error(`[plaud] fetch transcript error: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the apex team member who "owns" this meeting:
 *   1. If Plaud's payload includes an owner email that matches an apex
 *      team member, use that member.
 *   2. Otherwise, fall back to whoever connected the org-level Plaud
 *      account (apex_plaud_connections.connected_by).
 *   3. If neither resolves, return null and skip ingestion.
 */
export async function resolveOwnerUserId(ownerEmail?: string): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;

  if (ownerEmail) {
    const { rows } = await safeQuery<{ id: string }>(
      `SELECT id FROM apex_team_members WHERE email = $1 LIMIT 1`,
      [ownerEmail],
    );
    if (rows.length > 0) return rows[0].id;
  }

  const { rows } = await safeQuery<{ connected_by: string }>(
    `SELECT connected_by FROM apex_plaud_connections WHERE scope = 'org' LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].connected_by : null;
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

async function isAlreadyIngested(fileId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const { rows } = await safeQuery<{ id: string }>(
    `SELECT id FROM apex_meeting_transcripts WHERE file_id = $1 LIMIT 1`,
    [fileId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a single transcript end-to-end:
 *   fetch → quality gate → write to PG → triple-write to Qdrant/Neo4j → analytics
 */
export async function ingestTranscript(fileId: string): Promise<IngestResult> {
  // 1. Idempotency
  if (await isAlreadyIngested(fileId)) {
    trackEvent("plaud.transcript_duplicate", "system", "system", { file_id: fileId });
    return { status: "duplicate", fileId };
  }

  // 2. Fetch from Plaud
  const transcript = await fetchPlaudTranscript(fileId);
  if (!transcript || !transcript.transcript) {
    trackEvent("plaud.fetch_failed", "system", "system", { file_id: fileId });
    return { status: "fetch_failed", fileId };
  }

  // 3. Resolve owner
  const ownerUserId = await resolveOwnerUserId(transcript.ownerEmail);
  if (!ownerUserId) {
    trackEvent("plaud.no_owner", "system", "system", { file_id: fileId });
    return { status: "no_owner", fileId };
  }

  // 4. Doc quality gate
  const gate = checkDocQuality(transcript.transcript);
  if (gate.verdict === "reject") {
    // Still record the rejection so the learning loop sees it
    if (process.env.DATABASE_URL) {
      try {
        await query(
          `INSERT INTO apex_meeting_transcripts
             (file_id, owner_user_id, title, transcript_text, summary,
              recorded_at, duration_seconds, source, quality_status, quality_flags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'plaud', 'reject', $8)
           ON CONFLICT (file_id) DO NOTHING`,
          [
            fileId,
            ownerUserId,
            transcript.title || null,
            "[REJECTED BY QUALITY GATE]",
            transcript.summary || null,
            transcript.recordedAt || null,
            transcript.durationSeconds || null,
            JSON.stringify(gate.flags),
          ],
        );
      } catch (err) {
        console.error(`[plaud] failed to record rejection: ${(err as Error).message}`);
      }
    }
    trackEvent("plaud.transcript_rejected", ownerUserId, "system", {
      file_id: fileId,
      flag_count: gate.flags.length,
      reasons: gate.flags
        .filter((f) => f.severity === "reject")
        .map((f) => f.message)
        .join("; "),
    });
    return {
      status: "rejected",
      fileId,
      qualityStatus: "reject",
      flags: gate.flags,
      ownerUserId,
    };
  }

  // 5. Use sanitized content if the gate redacted PII (warn-level)
  const finalTranscript =
    gate.verdict === "warn" && gate.sanitizedContent
      ? gate.sanitizedContent
      : transcript.transcript;

  // 6. Write to PG (system of record)
  let insertedId: string | null = null;
  if (process.env.DATABASE_URL) {
    try {
      const result = await query<{ id: string }>(
        `INSERT INTO apex_meeting_transcripts
           (file_id, owner_user_id, title, transcript_text, summary,
            recorded_at, duration_seconds, source, quality_status, quality_flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'plaud', $8, $9)
         ON CONFLICT (file_id) DO UPDATE SET
           transcript_text = EXCLUDED.transcript_text,
           summary         = EXCLUDED.summary,
           quality_status  = EXCLUDED.quality_status,
           quality_flags   = EXCLUDED.quality_flags
         RETURNING id`,
        [
          fileId,
          ownerUserId,
          transcript.title || null,
          finalTranscript,
          transcript.summary || null,
          transcript.recordedAt || null,
          transcript.durationSeconds || null,
          gate.verdict,
          JSON.stringify(gate.flags),
        ],
      );
      insertedId = result.rows[0]?.id || null;
    } catch (err) {
      console.error(`[plaud] PG insert failed: ${(err as Error).message}`);
    }
  }

  // 7. Triple-write to Qdrant + Neo4j (fire-and-forget)
  if (insertedId) {
    void tripleWriteKnowledge(
      insertedId,
      transcript.title || "Meeting transcript",
      finalTranscript,
      "plaud_meeting",
      ownerUserId,
      ["meeting", "plaud", transcript.title || "untitled"],
    );
  }

  // 8. Analytics — every transcript ingestion attributed to its owner
  trackEvent("plaud.transcript_ingested", ownerUserId, "system", {
    file_id: fileId,
    quality_status: gate.verdict,
    flag_count: gate.flags.length,
    duration_seconds: transcript.durationSeconds || 0,
    transcript_length: finalTranscript.length,
  });

  return {
    status: "ingested",
    fileId,
    qualityStatus: gate.verdict,
    flags: gate.flags,
    ownerUserId,
  };
}

// ---------------------------------------------------------------------------
// Connection management (org-level)
// ---------------------------------------------------------------------------

export async function recordConnection(userId: string, displayName?: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await query(
    `INSERT INTO apex_plaud_connections (scope, connected_by, display_name)
     VALUES ('org', $1, $2)
     ON CONFLICT (scope) DO UPDATE SET
       connected_by = EXCLUDED.connected_by,
       display_name = COALESCE(EXCLUDED.display_name, apex_plaud_connections.display_name),
       updated_at   = NOW()`,
    [userId, displayName || null],
  );
}

export async function deleteConnection(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await query(`DELETE FROM apex_plaud_connections WHERE scope = 'org'`);
}

export async function getConnectionStatus(): Promise<{
  connected: boolean;
  connectedBy: string | null;
  displayName: string | null;
  connectedAt: string | null;
}> {
  if (!process.env.DATABASE_URL || !isPlaudConfigured()) {
    return { connected: false, connectedBy: null, displayName: null, connectedAt: null };
  }
  const { rows } = await safeQuery<{
    connected_by: string;
    display_name: string | null;
    connected_at: string;
  }>(
    `SELECT connected_by, display_name, connected_at
     FROM apex_plaud_connections
     WHERE scope = 'org'
     LIMIT 1`,
  );
  if (rows.length === 0) {
    return { connected: false, connectedBy: null, displayName: null, connectedAt: null };
  }
  return {
    connected: true,
    connectedBy: rows[0].connected_by,
    displayName: rows[0].display_name,
    connectedAt: rows[0].connected_at,
  };
}
