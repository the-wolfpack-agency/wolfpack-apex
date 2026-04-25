"use client";

/**
 * AttachmentBlock — one row in the meeting-message attachment list.
 *
 * Stream A's `/messages/[messageId]` page renders one of these per
 * attachment. Stream B owns this component:
 *
 *   - On click "View text", lazy-fetches /text via fetchWithRefresh
 *     (no eager network on render — a message with 10 attachments
 *     should not pre-fetch all 10 bodies).
 *   - On click "Download", navigates to /download (the route returns
 *     Content-Disposition: attachment so the browser saves the file).
 *   - When `extraction_status === "unsupported_mime"`, the View-text
 *     button is replaced by a static "Preview not available — download
 *     to view" caption. We never hit /text for a row we know will
 *     return null text.
 *
 * Visual states:
 *   - collapsed (default)
 *   - loading       — spinner-ish "Loading…" caption
 *   - extracted     — the extracted text in a <pre> block
 *   - unsupported   — static caption, no fetch
 *   - error         — "Couldn't load preview" caption + retry button
 *
 * Tailwind classes match the existing meeting / brain UI conventions
 * (border, rounded-md, bg-white, text-sm).
 */

import { useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export interface AttachmentBlockProps {
  feedSlug: string;
  messageId: string;
  attachment: {
    id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    extraction_status: "extracted" | "unsupported_mime" | "error";
  };
}

interface FetchedText {
  text: string | null;
  status: "extracted" | "unsupported_mime" | "error";
}

/** kB / MB display. Bytes are stored exact; UI rounds. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentBlock({
  feedSlug,
  messageId,
  attachment,
}: AttachmentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<FetchedText | null>(null);

  const isUnsupported = attachment.extraction_status === "unsupported_mime";
  const isError = attachment.extraction_status === "error";

  async function loadText() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/meetings/feeds/${encodeURIComponent(feedSlug)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}/text`,
      );
      if (!res.ok) {
        setError(`Failed to load preview (${res.status})`);
        setLoading(false);
        return;
      }
      const body = (await res.json()) as FetchedText;
      setFetched(body);
    } catch (e) {
      setError((e as Error).message ?? "network error");
    } finally {
      setLoading(false);
    }
  }

  function handleViewText() {
    if (!expanded) {
      setExpanded(true);
      // Only fetch the first time; subsequent collapse/expand reuses state.
      if (!fetched && !loading) void loadText();
    } else {
      setExpanded(false);
    }
  }

  const downloadHref = `/api/meetings/feeds/${encodeURIComponent(feedSlug)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}/download`;

  return (
    <div
      data-testid="attachment-block"
      className="rounded-md border border-gray-200 bg-white p-3 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={attachment.filename}>
            {attachment.filename}
          </div>
          <div className="text-xs text-gray-500">
            {attachment.mime || "unknown type"} · {formatBytes(attachment.size_bytes)}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {!isUnsupported && !isError && (
            <button
              type="button"
              onClick={handleViewText}
              className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
            >
              {expanded ? "Hide text" : "View text"}
            </button>
          )}
          <a
            href={downloadHref}
            className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          >
            Download
          </a>
        </div>
      </div>

      {isUnsupported && (
        <p className="mt-2 text-xs italic text-gray-500">
          Preview not available — download to view
        </p>
      )}
      {isError && (
        <p className="mt-2 text-xs italic text-red-600">
          We couldn&apos;t extract text from this file. Use Download to inspect
          the raw bytes.
        </p>
      )}

      {expanded && !isUnsupported && !isError && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          {loading && (
            <p data-testid="attachment-loading" className="text-xs text-gray-500">
              Loading…
            </p>
          )}
          {error && !loading && (
            <div className="space-y-2">
              <p className="text-xs text-red-600">{error}</p>
              <button
                type="button"
                onClick={loadText}
                className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
              >
                Retry
              </button>
            </div>
          )}
          {fetched && !loading && !error && (
            <>
              {fetched.status === "extracted" && (
                <pre
                  data-testid="attachment-text"
                  className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-mono text-xs"
                >
                  {fetched.text || "(empty document)"}
                </pre>
              )}
              {fetched.status === "unsupported_mime" && (
                <p className="text-xs italic text-gray-500">
                  Preview not available — download to view
                </p>
              )}
              {fetched.status === "error" && (
                <p className="text-xs italic text-red-600">
                  Extraction failed for this file.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AttachmentBlock;
