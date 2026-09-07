"use client";

/**
 * The documents an answer drew from, as cards instead of a raw-URL dump.
 *
 * Before this, sources showed two ways: a `**Sources retrieved:**` list baked
 * into the answer text with the full percent-encoded SharePoint URL as visible
 * link text (unreadable), and a "Show N sources" toggle that hid a plain
 * `title · type` list. This replaces both with a small set of cards, shown by
 * default: a file-type badge, the filename, and a click that opens the document
 * in its own source (SharePoint, the Sites view, wherever it lives) in a new
 * tab. We deliberately do NOT rebuild a document viewer inside Instinct — the
 * source system already renders these far better than we would.
 *
 * Pure presentation + one analytics callback on open. No knowledge of the
 * request or the answer.
 */

import { isSafeHref } from "@/lib/assistant/render-markdown";

export interface SourceCardItem {
  id: string;
  title: string;
  url: string;
  type: string;
}

export interface AssistantSourceCardsProps {
  sources: SourceCardItem[];
  /** Fired when a card is opened, for the learning loop. */
  onOpen?: (source: SourceCardItem) => void;
  testIdPrefix?: string;
}

/** A short, colored badge for a file, from its extension (or its type). Kept to
 *  a small known set; anything else falls back to the extension text or the
 *  source type, never a broken icon. */
function fileBadge(title: string, type: string): { label: string; color: string } {
  const ext = title.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
  const known: Record<string, { label: string; color: string }> = {
    pdf: { label: "PDF", color: "#ef4444" },
    doc: { label: "DOC", color: "#3b82f6" },
    docx: { label: "DOC", color: "#3b82f6" },
    xls: { label: "XLS", color: "#22c55e" },
    xlsx: { label: "XLS", color: "#22c55e" },
    csv: { label: "CSV", color: "#22c55e" },
    ppt: { label: "PPT", color: "#f97316" },
    pptx: { label: "PPT", color: "#f97316" },
    txt: { label: "TXT", color: "#9ca3af" },
    md: { label: "MD", color: "#9ca3af" },
  };
  if (ext && known[ext]) return known[ext];
  if (ext) return { label: ext.slice(0, 4).toUpperCase(), color: "var(--wp-gold, #eab308)" };
  return { label: (type || "DOC").slice(0, 4).toUpperCase(), color: "var(--wp-gold, #eab308)" };
}

export default function AssistantSourceCards({
  sources,
  onOpen,
  testIdPrefix = "source-card",
}: AssistantSourceCardsProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3" data-testid="assistant-source-cards">
      <div
        className="text-xs font-semibold mb-2"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        {sources.length === 1 ? "Source" : `${sources.length} sources`}
      </div>
      <div className="flex flex-col gap-2">
        {sources.map((s) => {
          const badge = fileBadge(s.title, s.type);
          const safe = isSafeHref(s.url);
          const external = s.url.startsWith("http");
          const inner = (
            <>
              <span
                className="shrink-0 rounded-md text-[10px] font-bold px-1.5 py-1 leading-none"
                style={{ background: badge.color, color: "#111" }}
                aria-hidden
              >
                {badge.label}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block text-sm truncate"
                  style={{ color: "var(--wp-text, #eee)" }}
                  title={s.title}
                >
                  {s.title}
                </span>
                <span className="block text-[11px]" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  {s.type}
                  {safe ? (external ? " · opens in the source" : " · opens in Instinct") : ""}
                </span>
              </span>
              {safe ? (
                <span
                  className="shrink-0 text-xs"
                  style={{ color: "var(--wp-gold, #eab308)" }}
                  aria-hidden
                >
                  {external ? "↗" : "→"}
                </span>
              ) : null}
            </>
          );

          const cardClass =
            "group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors";
          const cardStyle = {
            background: "var(--wp-dark-surface, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
          } as const;

          // Only a safe href becomes a link. An unsafe/empty url renders as a
          // non-interactive card rather than a dead or dangerous link.
          if (!safe) {
            return (
              <div
                key={s.id}
                className={cardClass}
                style={cardStyle}
                data-testid={`${testIdPrefix}-${s.id}`}
              >
                {inner}
              </div>
            );
          }

          return (
            <a
              key={s.id}
              href={s.url}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              onClick={() => onOpen?.(s)}
              className={`${cardClass} hover:border-[var(--wp-gold,#eab308)]`}
              style={cardStyle}
              data-testid={`${testIdPrefix}-${s.id}`}
            >
              {inner}
            </a>
          );
        })}
      </div>
    </div>
  );
}
