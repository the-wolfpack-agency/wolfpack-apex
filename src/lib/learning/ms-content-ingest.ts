/**
 * Microsoft content → Wolfpack Assistant RAG ingest.
 *
 * The Assistant's zero-token path reads from `instinct_knowledge` (Postgres,
 * searched via pg_trgm in `@/lib/knowledge`). The triple-write orchestrator
 * fans that write out to Qdrant + Neo4j via `saveAnswer`.
 *
 * RAG integration path chosen: **direct-write** through `saveAnswer`.
 *   - Reuses existing PG + Qdrant + Neo4j fan-out (one code path)
 *   - No new queue, no new infra, no new runtime deps
 *   - Dedup via UNIQUE(question, asked_by) on instinct_knowledge? No — we key
 *     on stable doc ids (e.g. `ms-teams:<messageId>`) via source field to
 *     keep it replayable without schema changes; duplicate writes are
 *     idempotent against the knowledge + triple-write stores.
 *
 * Failure policy (critical): ingestion NEVER blocks sync. Every helper
 * wraps its saveAnswer call in try/catch and surfaces the error to the
 * caller so the caller can emit `system.ms_teams_sync_indexing_failed`
 * and keep going. Callers in this codebase log the event for learning.
 */

import { saveAnswer } from "@/lib/knowledge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamsIngestMessage {
  msMessageId: string;
  chatId: string;
  msChatId: string;
  chatTopic: string | null;
  sender: string;
  body: string;
  createdAt: string;
}

export interface OneNoteIngestPage {
  msPageId: string;
  title: string;
  preview: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Teams messages
// ---------------------------------------------------------------------------

/**
 * Index a single Teams message into the Assistant RAG. The "question" is
 * a synthesized phrase that lets the Assistant's trigram lookup find the
 * right message when asked e.g. "what did Alex say about the Q2 budget?".
 *
 * Returns void on success. Throws the underlying error so the caller can
 * log + continue (never blocks sync).
 */
export async function indexTeamsMessage(
  userId: string,
  msg: TeamsIngestMessage,
): Promise<void> {
  // Skip empty bodies — system messages, reactions, etc.
  if (!msg.body || msg.body.trim().length === 0) return;

  const topic = msg.chatTopic ? ` (${msg.chatTopic})` : "";
  const question = `Teams message from ${msg.sender}${topic}: ${msg.body.slice(0, 160)}`;
  const answer = msg.body;

  // saveAnswer returns null on shadow-mode / DB failure. We still want the
  // promise to reject in that case so the caller can count indexing failures
  // distinctly from happy-path shadow usage.
  const entry = await saveAnswer(
    question,
    answer,
    "teams_message",
    userId,
    undefined,
    undefined,
    0,
  );

  if (!entry) {
    throw new Error(`saveAnswer returned null for teams message ${msg.msMessageId}`);
  }
}

// ---------------------------------------------------------------------------
// OneNote pages
// ---------------------------------------------------------------------------

/**
 * Index a single OneNote page into the Assistant RAG. Uses title + preview
 * as the searchable blob; full page HTML is fetched on-demand via
 * getPageContent when the Assistant retrieves a hit.
 */
export async function indexOneNotePage(
  userId: string,
  page: OneNoteIngestPage,
): Promise<void> {
  const question = `OneNote page: ${page.title}`;
  // Preview can be empty on shell-only upserts — still index by title so
  // retrieval works and a future sync can replace the preview.
  const answer = page.preview && page.preview.length > 0
    ? `${page.title}\n\n${page.preview}`
    : page.title;

  const entry = await saveAnswer(
    question,
    answer,
    "onenote_page",
    userId,
    undefined,
    undefined,
    0,
  );

  if (!entry) {
    throw new Error(`saveAnswer returned null for onenote page ${page.msPageId}`);
  }
}
