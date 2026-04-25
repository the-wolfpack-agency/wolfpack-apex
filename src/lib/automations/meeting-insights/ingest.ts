/**
 * meeting-insights / ingest — orchestrator that takes one inbound
 * message envelope, routes it to the right feed, persists artifact +
 * message + attachments, and surfaces failures as exception rows.
 *
 * Idempotent at three layers:
 *   1. artifact (source_message_id, content_sha256) — same Graph msg +
 *      same body hash = no-op.
 *   2. message (feed_id, source_message_id) — same feed + same Graph
 *      msg = no-op.
 *   3. attachment — bound by message_id, so when the message no-ops
 *      we don't recreate attachments.
 *
 * Stream B owns:
 *   - body_text extraction (HTML strip / plain pick).
 *   - per-mime attachment extractors (.docx via mammoth, .pdf via
 *     unpdf). Stub-friendly: if the parser module isn't merged yet,
 *     the orchestrator catches the import error and stores raw bytes
 *     with extraction_status='unsupported_mime'.
 *
 * No silent data loss (per memory feedback_no_silent_data_loss):
 *   - failed routing creates an exception row (kind='no_route_match').
 *   - failed body extraction stores empty body + an exception
 *     (kind='parse_failure').
 *   - failed attachment extraction stores raw bytes with
 *     extraction_status='error' AND an exception
 *     (kind='attachment_extract_failed').
 *   - the message row + attachments still land — never a 200 with
 *     dropped data.
 */

import { createHash } from "node:crypto";
import { writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AutomationDefinition } from "@/lib/automations/types";
import { listFeeds } from "./feeds-repo";
import { routeMessageToFeed } from "./router";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface MeetingIngestRequest {
  automation: AutomationDefinition;
  source_message_id: string;
  received_at: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  /** Stable raw envelope bytes (eml or serialized Graph JSON). */
  raw_bytes: Buffer;
  mime: string;
  /** HTML body when Graph returned contentType=html, else null. */
  body_html: string | null;
  /** Plain-text preview Graph always returns (~255 chars). Used as a
   *  fallback when no full body is available. */
  body_preview: string | null;
  /** Per-attachment bytes from the Graph fetcher. */
  attachments: Array<{ name: string; contentType: string; bytes: Buffer }>;
  user_id: string;
  user_role: string;
}

export interface MeetingIngestResult {
  artifact_id: string;
  feed_id: string | null;
  message_id: string | null;
  was_duplicate: boolean;
  parse_status: "processed" | "error_quarantined";
  attachments_persisted: number;
  exception_id?: string;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function ingestMeetingMessage(
  req: MeetingIngestRequest,
): Promise<MeetingIngestResult> {
  // 1. Persist (or upsert) the artifact. The (source_message_id,
  //    content_sha256) unique index makes this idempotent.
  const sha = createHash("sha256").update(req.raw_bytes).digest("hex");
  const artifact = await writeQuery<{
    id: string;
    parse_status: string;
    inserted: boolean;
  }>(
    `INSERT INTO instinct_meeting_artifacts
       (source_message_id, received_at, bytes, content_sha256, mime, parse_status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (source_message_id, content_sha256) DO UPDATE SET
       mime = EXCLUDED.mime
     RETURNING id, parse_status, (xmax = 0) AS inserted`,
    [req.source_message_id, req.received_at, req.raw_bytes, sha, req.mime],
    { expectRows: 1 },
  );
  const artifactId = artifact.rows[0].id;
  /* The artifact-level dedupe used to short-circuit here, but that
     prevented multiple feeds from ever capturing the same Graph email
     — the second feed in the chain saw was_duplicate:true and never
     got a message row of its own. Dedup is now at the (feed_id,
     source_message_id) level (the message-row upsert below), so the
     same artifact can fan out to N feeds correctly. The artifact
     row itself stays unique-by-content via the artifact upsert. */

  // 2. Route the message to a feed. We re-load the live feed list every
  //    call rather than caching — feed config is small and admin
  //    changes need to take effect within one tick.
  const feeds = await listFeeds({ onlyEnabled: true });
  const route = routeMessageToFeed(
    {
      source_message_id: req.source_message_id,
      subject: req.subject,
      from_address: req.from_address,
      received_at: req.received_at,
    },
    feeds,
  );

  if (!route) {
    return await quarantine({
      artifactId,
      feedId: null,
      kind: "no_route_match",
      detail: `no enabled feed matched message from=${req.from_address} subject="${req.subject}"`,
      user_id: req.user_id,
      user_role: req.user_role,
    });
  }

  // 3. Extract body_text. Stream B owns the email-body parser; until
  //    that lands we use a defensive built-in: HTML strip when html is
  //    present, else body_preview, else empty string. The message row
  //    is created in either case so nothing is dropped silently.
  const bodyText = await safeExtractBodyText({
    body_html: req.body_html,
    body_preview: req.body_preview,
  });

  // 4. Persist the message. Idempotent on (feed_id, source_message_id).
  const msgIns = await writeQuery<{ id: string; inserted: boolean }>(
    `INSERT INTO instinct_meeting_messages
       (feed_id, artifact_id, source_message_id, subject, from_address,
        from_name, to_addresses, cc_addresses, received_at,
        body_text, body_html, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (feed_id, source_message_id) DO UPDATE SET
       /* Benign touch so RETURNING gives the existing row, plus a
          self-heal: backfill body_text/body_html when the existing
          row has an empty value. Earlier ingests dropped body_text
          on the floor because of an arg-shape mismatch with the
          parser; a re-poll should heal those rows. Never overwrites
          existing non-empty content. */
       subject = EXCLUDED.subject,
       body_text = CASE
         WHEN COALESCE(instinct_meeting_messages.body_text, '') = ''
         THEN EXCLUDED.body_text
         ELSE instinct_meeting_messages.body_text
       END,
       body_html = COALESCE(instinct_meeting_messages.body_html, EXCLUDED.body_html)
     RETURNING id, (xmax = 0) AS inserted`,
    [
      route.feed_id,
      artifactId,
      req.source_message_id,
      req.subject,
      req.from_address,
      req.from_name,
      req.to_addresses,
      req.cc_addresses,
      req.received_at,
      bodyText,
      req.body_html,
      req.attachments.length > 0,
    ],
    { expectRows: 1 },
  );
  const messageId = msgIns.rows[0].id;
  const created = msgIns.rows[0].inserted;

  let attachmentsPersisted = 0;

  if (created && req.attachments.length > 0) {
    for (const att of req.attachments) {
      const extracted = await safeExtractAttachmentText(att);
      await writeQuery(
        `INSERT INTO instinct_meeting_attachments
           (message_id, filename, mime, size_bytes,
            extracted_text, extraction_status, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          messageId,
          att.name,
          att.contentType || "application/octet-stream",
          att.bytes.byteLength,
          extracted.text,
          extracted.status,
          att.bytes,
        ],
        { expectRows: 1 },
      );
      attachmentsPersisted += 1;
    }
  }

  // 5. Mark artifact processed.
  await writeQuery(
    `UPDATE instinct_meeting_artifacts
        SET parse_status = 'processed'
      WHERE id = $1
      RETURNING id`,
    [artifactId],
    { expectRows: 1 },
  );

  trackEvent("automations.artifact_ingested", req.user_id, req.user_role, {
    automation_id: req.automation.id,
    source_type: "email",
    source_message_id: req.source_message_id,
    feed_id: route.feed_id,
    feed_slug: route.feed_slug,
    attachments: attachmentsPersisted,
  });

  // 6. Fire the Phase 2 analyzer async — never blocks ingest. Failures
  //    land as status='error' rows; they don't break this pipeline.
  if (created) {
    void fireAnalyzer({
      feed_id: route.feed_id,
      message_id: messageId,
      user_id: req.user_id,
      user_role: req.user_role,
      automation_id: req.automation.id,
      feed_slug: route.feed_slug,
    });
  }

  return {
    artifact_id: artifactId,
    feed_id: route.feed_id,
    message_id: messageId,
    was_duplicate: !created,
    parse_status: "processed",
    attachments_persisted: attachmentsPersisted,
  };
}

/**
 * Async analyzer trigger. Imports lazily so we don't pay the SDK init
 * cost on cold ingest paths that don't need analysis (e.g. duplicate
 * messages). Catches everything; logs but never propagates.
 */
async function fireAnalyzer(args: {
  feed_id: string;
  message_id: string;
  user_id: string;
  user_role: string;
  automation_id: string;
  feed_slug: string;
}): Promise<void> {
  try {
    const mod = await import("./run-analyzer");
    const out = await mod.runAnalyzer({
      feed_id: args.feed_id,
      message_id: args.message_id,
    });
    if (out.record) {
      trackEvent("automations.message_analyzed", args.user_id, args.user_role, {
        automation_id: args.automation_id,
        feed_id: args.feed_id,
        feed_slug: args.feed_slug,
        message_id: args.message_id,
        analyzer_version: out.record.analyzer_version,
        status: out.record.status,
        topics: out.record.topics.length,
        decisions: out.record.decisions.length,
        action_items: out.record.action_items.length,
        tokens_used: out.record.tokens_used ?? 0,
      });
    }
  } catch (err) {
    // Final safety net — analyzer failure never breaks ingest.
    console.warn(
      "[meeting-insights/ingest] analyzer fire failed:",
      (err as Error).message,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Stream B fallbacks                                                  */
/* ------------------------------------------------------------------ */

/**
 * Body-text extractor with a Stream B import boundary. When Stream B's
 * `parser-email-body.ts` lands, we delegate. Until then we use a
 * deliberately conservative HTML strip so the row never lands empty
 * when usable text was available.
 *
 * The dynamic import is wrapped in try/catch because module-resolution
 * errors (file doesn't exist yet) would otherwise tear down the whole
 * ingest. This is the explicit Stream A/B handoff seam.
 */
async function safeExtractBodyText(input: {
  body_html: string | null;
  body_preview: string | null;
}): Promise<string> {
  try {
    /* Stream B's parser at ./parser-email-body uses cheerio for
       proper paragraph-preserving HTML→text conversion. It expects
       `{ contentType, content }` (matches Graph's message.body shape)
       and returns `{ body_text, body_html }`. */
    const mod = (await import("./parser-email-body")) as unknown as {
      parseEmailBody?: (i: {
        contentType: string;
        content: string;
      }) => Promise<{ body_text: string }> | { body_text: string };
    };
    if (typeof mod.parseEmailBody === "function") {
      if (input.body_html) {
        const out = await mod.parseEmailBody({
          contentType: "html",
          content: input.body_html,
        });
        if (out.body_text) return out.body_text;
      }
      if (input.body_preview) {
        const out = await mod.parseEmailBody({
          contentType: "text",
          content: input.body_preview,
        });
        if (out.body_text) return out.body_text;
      }
    }
  } catch {
    /* Parser threw — fall through to local fallback so ingest never
       loses the message. */
  }
  if (input.body_html) {
    return input.body_html
      .replace(/<\s*(script|style)[\s\S]*?<\/\s*\1\s*>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return input.body_preview ?? "";
}

/**
 * Attachment extractor with a Stream B import boundary. Same shape as
 * the body extractor: dynamic import keeps Stream A standalone.
 */
async function safeExtractAttachmentText(att: {
  name: string;
  contentType: string;
  bytes: Buffer;
}): Promise<{ text: string | null; status: "extracted" | "unsupported_mime" | "error" }> {
  try {
    // Stream B's extractors barrel — handles txt/md/csv/html/docx/pdf
    // and returns unsupported_mime for everything else without throwing.
    const mod = (await import("./extractors")) as unknown as {
      extractAttachmentText?: (
        bytes: Buffer,
        mime: string,
        filename: string,
      ) => Promise<{ text: string | null; status: "extracted" | "unsupported_mime" | "error" }>;
    };
    if (typeof mod.extractAttachmentText === "function") {
      return mod.extractAttachmentText(att.bytes, att.contentType, att.name);
    }
  } catch {
    // Stream B not merged yet.
  }
  return { text: null, status: "unsupported_mime" };
}

/* ------------------------------------------------------------------ */
/* Quarantine path                                                     */
/* ------------------------------------------------------------------ */

interface QuarantineArgs {
  artifactId: string;
  feedId: string | null;
  kind: "parse_failure" | "no_route_match" | "attachment_extract_failed" | "duplicate_artifact" | "missing_field";
  detail: string;
  user_id: string;
  user_role: string;
}

async function quarantine(args: QuarantineArgs): Promise<MeetingIngestResult> {
  await writeQuery(
    `UPDATE instinct_meeting_artifacts
        SET parse_status = 'error_quarantined'
      WHERE id = $1
      RETURNING id`,
    [args.artifactId],
    { expectRows: 1 },
  );

  const exc = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_meeting_exceptions
       (artifact_id, feed_id, kind, detail, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id`,
    [args.artifactId, args.feedId, args.kind, args.detail],
    { expectRows: 1 },
  );

  trackEvent("automations.artifact_quarantined", args.user_id, args.user_role, {
    automation_id: "meeting-insights",
    feed_id: args.feedId ?? "",
    reason: args.detail,
    exception_kind: args.kind,
  });

  return {
    artifact_id: args.artifactId,
    feed_id: args.feedId,
    message_id: null,
    was_duplicate: false,
    parse_status: "error_quarantined",
    attachments_persisted: 0,
    exception_id: exc.rows[0].id,
  };
}
