/**
 * upload_to_brain — the assistant tool that surfaces the dedicated
 * "drop files here, into your Brain" widget.
 *
 * Trigger phrases (anchored ^/$ so a sentence containing the words
 * doesn't hijack the dispatcher):
 *   /upload
 *   upload
 *   upload to brain
 *   /upload to brain
 *   i want to upload (something) (.+)?
 *   let me upload …
 *   how do i upload …
 *
 * Hard guard: messages containing an explicit URL or a /path/ token
 * defer to the "ingest from URL" flow (not yet implemented; we
 * intentionally don't claim those so a future tool can land there
 * without a routing fight).
 *
 * Handler is a pure widget bootstrap: no data fetch, no DB call. The
 * UploadToBrainWidget renders inline, the user drops files, and each
 * file POSTs to /api/brain/upload which runs the data-quality filter
 * before delegating to the existing ingest() pipeline.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import {
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
  UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
} from "@/lib/brain/upload-filter";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { UploadToBrainWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface UploadToBrainData {
  kind: "upload_to_brain";
  uploadUrl: string;
}

const SLASH_OR_BARE_RE = /^\s*\/?upload(?:\s+to\s+brain)?\s*[?.!]?\s*$/i;
const NL_INTENT_RE =
  /^\s*(?:i\s+(?:want\s+to|would\s+like\s+to)|let\s+me|how\s+do\s+i)\s+upload(?:\s+(?:something|a\s+file|files?|to\s+(?:my\s+)?brain))?\s*[?.!]?\s*$/i;
/* Reject when the user clearly already has a URL or a filesystem-style
 * path token — that's a different flow (ingest-from-URL). NOTE: the
 * leading "/upload" slash-command form is NOT a path; the guard runs
 * AFTER the slash-command match so a literal "/upload" / "/upload to
 * brain" wins. */
const URL_RE = /https?:\/\/\S+/i;
/* Filesystem-style path: a `/` with content on BOTH sides, e.g.
 * "/Users/nick/notes.md" or "open /etc/foo". Excludes a bare leading
 * "/upload" which the slash-command match already handled. */
const PATH_RE = /(?:^|\s)\/[A-Za-z0-9._-]+\/\S+/i;

export function matchUploadToBrainIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  /* Slash-command match wins first so "/upload" never trips the path
   * guard. */
  if (SLASH_OR_BARE_RE.test(trimmed)) return {};
  if (URL_RE.test(trimmed) || PATH_RE.test(trimmed)) return null;
  if (NL_INTENT_RE.test(trimmed)) return {};
  return null;
}

export const uploadToBrainTool: ToolDef<Params, UploadToBrainData> = {
  name: "upload_to_brain",
  description:
    "Open a drag/drop panel that adds files directly to the user's Brain. Files are filtered for size, type, secrets, PII, and duplicates before ingest. Use when the user says 'upload', '/upload', 'upload to brain', or 'I want to upload'.",
  paramSchema: ParamSchema,
  capability: "brain.ingest",
  matchIntent: matchUploadToBrainIntent,
  async handler(_params, ctx): Promise<ToolResult<UploadToBrainData>> {
    const spec: UploadToBrainWidgetSpec = {
      kind: "upload_to_brain",
      uploadUrl: "/api/brain/upload",
      maxFileSize: UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
      allowedMimeTypes: UPLOAD_FILTER_ALLOWED_MIME_TYPES,
    };

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "upload_to_brain",
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });

    return {
      ok: true,
      data: {
        kind: "upload_to_brain",
        uploadUrl: spec.uploadUrl,
      },
      answer:
        "Drop files in the panel to add them to your Brain. I'll check each one before ingesting.",
      sources: [],
      widget: spec,
    };
  },
};

registerTool(uploadToBrainTool);
