/**
 * SearchResultsWidget — inline universal-search results rendered in chat.
 *
 * Mirrors the /search page's source-filter UX: a checkbox row at the
 * top (one per source that has non-zero results: Chats / Channels /
 * Emails / Calendar / Knowledge / CRM), then a single flat result list
 * filtered to the checked sources client-side. Unchecking a box hides
 * results of that type without refetching — same UX the page surface
 * uses.
 *
 * A "Search again" button at the bottom emits a follow-up analytics
 * event (`assistant.search_refilter_requested`) so the learning loop
 * sees when users want to narrow a chat-driven search to a subset of
 * sources. The full re-prompt-the-assistant pattern doesn't exist in
 * the chat surface yet — when it lands, this widget will swap the
 * analytics stub for an actual message dispatch. Documented as a
 * follow-up in `.ai/conventions.md` under "Widget interfaces".
 *
 * Empty-results path: renders an inline "no results for <query>"
 * message with the same dashed border the /search page uses. No
 * checkboxes or refresh button — there's nothing to filter.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type {
  SearchResultsWidgetSpec,
  SearchResultsWidgetResult,
} from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

/* ---------------------------------------------------------------------
 * Source labels + ordering — matches the /search page TYPE_LABELS /
 * TYPE_ORDER constants so the chat surface and the page surface read
 * consistent to the user.
 * ------------------------------------------------------------------- */

type SourceType = SearchResultsWidgetResult["type"];

const TYPE_LABELS: Record<SourceType, string> = {
  chat: "Chats",
  channel: "Channels",
  email: "Emails",
  calendar: "Calendar",
  knowledge: "Knowledge",
  crm: "CRM",
  dms: "Inventory",
};

const TYPE_ORDER: SourceType[] = [
  "chat",
  "channel",
  "email",
  "calendar",
  "knowledge",
  "crm",
  "dms",
];

/** Map a SourceType onto the `counts` key the SearchResponse uses. */
const COUNT_KEY: Record<SourceType, string> = {
  chat: "chats",
  channel: "channels",
  email: "emails",
  calendar: "calendar",
  knowledge: "knowledge",
  crm: "crm",
  dms: "dms",
};

function formatRelative(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff < 0;
  const mag = future ? "in " : "";
  const suf = future ? "" : " ago";
  if (abs < minute) return "just now";
  if (abs < hour) return `${mag}${Math.round(abs / minute)}m${suf}`;
  if (abs < day) return `${mag}${Math.round(abs / hour)}h${suf}`;
  if (abs < 7 * day) return `${mag}${Math.round(abs / day)}d${suf}`;
  return new Date(iso).toLocaleDateString();
}

export interface SearchResultsWidgetProps {
  spec: SearchResultsWidgetSpec;
  workflowId?: string;
}

export function SearchResultsWidget({
  spec,
  workflowId,
}: SearchResultsWidgetProps) {
  /* Sources with > 0 hits are the only ones that get a checkbox.
   *  Sources with zero hits stay collapsed — matches the /search page's
   *  group-skip behavior. */
  const availableSources = useMemo<SourceType[]>(() => {
    return TYPE_ORDER.filter((t) => (spec.counts[COUNT_KEY[t]] ?? 0) > 0);
  }, [spec.counts]);

  /* Default state: every available source checked. */
  const [activeSources, setActiveSources] = useState<Set<SourceType>>(
    () => new Set(availableSources),
  );

  /* When the spec changes (new search reruns), reset the active set. */
  useEffect(() => {
    setActiveSources(new Set(availableSources));
  }, [availableSources]);

  /* widget_rendered — fired once per mount. Mirrors the shape every
   *  other widget uses (calendar / email_thread / task_list). */
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "search_results",
          result_count: spec.results.length,
          source_count: availableSources.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.results.length, availableSources.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "search_results",
    itemCount: spec.results.length,
    workflowId,
  });

  function trackInteraction(action: string, value?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "search_results",
          action,
          ...(value !== undefined ? { value } : {}),
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  function toggleSource(t: SourceType) {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
        /* Never leave an empty filter — empty = all available, same
         *  invariant the /search page enforces. */
        if (next.size === 0) return new Set(availableSources);
      } else {
        next.add(t);
      }
      return next;
    });
    trackInteraction("toggle_source", t);
  }

  function handleSearchAgain() {
    /* No re-prompt path lives in the chat surface yet. Fire a
     *  stub analytics event so the learning loop sees demand for a
     *  narrowed re-search and we can wire the actual re-prompt
     *  message once the surface supports it. The follow-up wiring is
     *  documented in `.ai/conventions.md` under "Widget interfaces". */
    const narrowed = Array.from(activeSources);
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.search_refilter_requested",
        metadata: {
          widget_kind: "search_results",
          query: spec.query,
          types: narrowed.join(","),
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
    trackInteraction("search_again", narrowed.join(","));
  }

  /* Client-side filter — preserves the original ordering runSearch
   *  returned (the engine's interleave). */
  const filtered = useMemo<SearchResultsWidgetResult[]>(() => {
    return spec.results.filter((r) => activeSources.has(r.type));
  }, [spec.results, activeSources]);

  return (
    <div
      data-testid="search-results-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        className="flex items-center justify-between mb-2"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        <div>
          <div className="text-sm font-semibold">Search results</div>
          <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            {spec.results.length} result{spec.results.length === 1 ? "" : "s"} in {spec.took_ms}ms for &ldquo;{spec.query}&rdquo;
          </div>
        </div>
        <a
          href={`/search?q=${encodeURIComponent(spec.query)}`}
          onClick={() => trackInteraction("open_search_page")}
          className="text-xs"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Open in full search
        </a>
      </div>

      {spec.results.length === 0 ? (
        <div
          data-testid="search-results-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No results for &ldquo;{spec.query}&rdquo;.
        </div>
      ) : (
        <>
          {/* Source-filter checkbox row — one per non-zero source. */}
          <div
            role="group"
            aria-label="Filter by source"
            className="flex flex-wrap gap-2 mb-2"
            data-testid="search-results-filters"
          >
            {availableSources.map((t) => {
              const active = activeSources.has(t);
              const count = spec.counts[COUNT_KEY[t]] ?? 0;
              return (
                <label
                  key={t}
                  data-testid={`search-results-filter-${t}`}
                  className="text-xs flex items-center gap-1 cursor-pointer select-none rounded px-2 py-1"
                  style={{
                    background: active
                      ? "var(--wp-gold, #eab308)"
                      : "transparent",
                    color: active
                      ? "var(--wp-bg, #111)"
                      : "var(--wp-text-dim, #aaa)",
                    border: `1px solid ${active ? "var(--wp-gold, #eab308)" : "var(--wp-dark-border, #333)"}`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleSource(t)}
                    aria-label={`Toggle ${TYPE_LABELS[t]}`}
                    data-testid={`search-results-filter-input-${t}`}
                    style={{ accentColor: "var(--wp-gold, #eab308)" }}
                  />
                  {TYPE_LABELS[t]} · {count}
                </label>
              );
            })}
          </div>

          <ul className="space-y-1" data-testid="search-results-list">
            {filtered.length === 0 ? (
              <li
                data-testid="search-results-filtered-empty"
                className="text-xs py-2 text-center"
                style={{ color: "var(--wp-text-muted, #6b7280)" }}
              >
                No results in the selected sources.
              </li>
            ) : (
              filtered.map((r, idx) => {
                const isExternal = !!r.url && /^https?:\/\//i.test(r.url);
                const href = r.url || "#";
                return (
                  <StaggeredItem
                    key={`${r.type}:${r.id}`}
                    index={idx}
                    data-testid={`search-results-row-${r.type}-${r.id}`}
                    className="text-xs rounded px-2 py-1.5"
                    style={{
                      background: "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href={href}
                        target={isExternal ? "_blank" : undefined}
                        rel={isExternal ? "noopener noreferrer" : undefined}
                        onClick={() => trackInteraction("open_result", `${r.type}:${r.id}`)}
                        className="truncate font-semibold"
                        style={{ color: "var(--wp-text, #eee)" }}
                      >
                        {r.title}
                      </a>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          data-testid={`search-results-badge-${r.type}`}
                          className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5"
                          style={{
                            background: "var(--wp-dark-surface, #1a1a1a)",
                            color: "var(--wp-text-muted, #6b7280)",
                            border: "1px solid var(--wp-dark-border, #333)",
                          }}
                        >
                          {TYPE_LABELS[r.type]}
                        </span>
                        <span style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                          {formatRelative(r.timestamp)}
                        </span>
                      </div>
                    </div>
                    {r.snippet && (
                      <div className="truncate" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                        {r.snippet}
                      </div>
                    )}
                  </StaggeredItem>
                );
              })
            )}
          </ul>

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={handleSearchAgain}
              data-testid="search-results-refresh"
              className="text-xs rounded px-2 py-1"
              style={{
                background: "transparent",
                color: "var(--wp-gold, #eab308)",
                border: "1px solid var(--wp-gold, #eab308)",
                cursor: "pointer",
              }}
            >
              Search again in selected sources
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default SearchResultsWidget;
