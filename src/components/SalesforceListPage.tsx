"use client";

/**
 * Shared client component for the three list routes
 * (contacts / opportunities / accounts).
 *
 * One component, three render shapes — accepts the portal `type` plus a
 * column descriptor so each list page is a thin wrapper that just picks
 * which columns it wants. The fetch, debounce, load-more, and modal
 * wiring live here so a column change doesn't fork the data layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";
import SalesforceCreateModal from "@/components/SalesforceCreateModal";

export type PortalType = "contacts" | "opportunities" | "accounts";

export interface ListColumn {
  key: string;
  label: string;
  /** Optional second key tried if the first is missing — for SF
   *  relationship fields like Account.Name we look at the nested
   *  Account object too. */
  fallbackKey?: string;
  /** True for the column whose value links into the drill-in. Default
   *  picks "Name". */
  primary?: boolean;
  render?: (record: Record<string, unknown>) => string;
}

interface SalesforceListPageProps {
  type: PortalType;
  title: string;
  description: string;
  columns: ListColumn[];
  /** Optional stage chips for the opportunities page. */
  stages?: string[];
}

interface ListResponse {
  notConfigured: boolean;
  records: Array<Record<string, unknown>>;
  hasMore: boolean;
  connector: string;
}

const PAGE_LIMIT = 50;

function readColumn(record: Record<string, unknown>, col: ListColumn): string {
  if (col.render) return col.render(record);
  const candidates = [col.key, col.fallbackKey].filter(Boolean) as string[];
  for (const k of candidates) {
    /* Support dotted keys for SF relationship fields ("Account.Name"). */
    const parts = k.split(".");
    let cur: unknown = record;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "string" && cur.length > 0) return cur;
    if (typeof cur === "number") return String(cur);
  }
  return "—";
}

export default function SalesforceListPage({ type, title, description, columns, stages }: SalesforceListPageProps) {
  const router = useRouter();
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [hasMore, setHasMore] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (params: { q: string; stagesCSV: string; offset: number; append: boolean }) => {
      if (params.append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const search = new URLSearchParams({
          type,
          q: params.q,
          stage: params.stagesCSV,
          limit: String(PAGE_LIMIT),
          offset: String(params.offset),
        });
        const res = await fetchWithRefresh(`/api/portal/salesforce/list?${search.toString()}`);
        if (!res.ok) {
          setError(`Could not load ${type} (HTTP ${res.status}).`);
          if (!params.append) setRecords([]);
          return;
        }
        const body = (await res.json()) as ListResponse;
        setNotConfigured(body.notConfigured);
        setHasMore(body.hasMore);
        setRecords((prev) => (params.append ? [...prev, ...body.records] : body.records));
      } catch (e) {
        setError((e as Error).message || "Network error");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [type],
  );

  /* Initial + filter-change fetch — debounced on the search query so
     keystrokes don't spam the connector. */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchPage({
        q: query,
        stagesCSV: selectedStages.join(","),
        offset: 0,
        append: false,
      });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, selectedStages, fetchPage]);

  const primaryCol = useMemo<ListColumn>(
    () => columns.find((c) => c.primary) ?? columns[0],
    [columns],
  );

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: 24, color: "var(--wp-text, #fff)" }}>
      <div style={{ marginBottom: 8 }}>
        <Link href="/portal/salesforce" style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>
          ← Salesforce portal
        </Link>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4, gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>{title}</h1>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          style={primaryBtnStyle}
          data-testid={`sf-list-new-${type}`}
        >
          + New
        </button>
      </div>
      <p style={{ color: "var(--wp-text-dim, #a0a8b4)", marginBottom: 16 }}>{description}</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${type}…`}
          data-testid={`sf-list-search-${type}`}
          style={{
            flex: "1 1 240px",
            background: "var(--wp-dark-surface2, #16181c)",
            color: "var(--wp-text, #fff)",
            border: "1px solid var(--wp-dark-border, #2a2c30)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 13,
          }}
        />
      </div>

      {stages && stages.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }} data-testid="sf-stage-chips">
          {stages.map((s) => {
            const active = selectedStages.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() =>
                  setSelectedStages((prev) =>
                    active ? prev.filter((x) => x !== s) : [...prev, s],
                  )
                }
                style={{
                  padding: "4px 10px",
                  background: active ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #16181c)",
                  color: active ? "var(--wp-dark, #111)" : "var(--wp-text, #fff)",
                  border: "1px solid var(--wp-dark-border, #2a2c30)",
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...cardStyle, marginBottom: 16, borderColor: "var(--wp-red, #ef4444)" }}>
          <p style={{ color: "var(--wp-red, #ef4444)", margin: 0 }}>{error}</p>
        </div>
      )}

      {notConfigured ? (
        <div style={cardStyle} data-testid="sf-list-cta">
          <p>Salesforce isn&apos;t connected for this workspace.</p>
          <Link href="/admin/connectors" style={ctaLinkStyle}>
            Connect Salesforce →
          </Link>
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }} data-testid={`sf-list-table-${type}`}>
              <thead>
                <tr style={{ background: "var(--wp-dark-surface2, #16181c)" }}>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      style={{
                        textAlign: "left",
                        padding: "10px 12px",
                        fontSize: 12,
                        color: "var(--wp-text-dim, #a0a8b4)",
                        borderBottom: "1px solid var(--wp-dark-border, #2a2c30)",
                      }}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && records.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} style={{ padding: 16, color: "var(--wp-text-dim, #a0a8b4)" }}>
                      Loading…
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} style={{ padding: 16, color: "var(--wp-text-dim, #a0a8b4)" }}>
                      No {type} match the current search.
                    </td>
                  </tr>
                ) : (
                  records.map((r, i) => {
                    const id = typeof r.Id === "string" ? r.Id : typeof r.id === "string" ? r.id : "";
                    return (
                      <tr key={`${id || i}`} style={{ borderBottom: "1px solid var(--wp-dark-border, #2a2c30)" }}>
                        {columns.map((c, ci) => {
                          const value = readColumn(r, c);
                          if (c === primaryCol && id) {
                            return (
                              <td key={ci} style={{ padding: "10px 12px", fontSize: 13 }}>
                                <Link
                                  href={`/portal/salesforce/${type}/${encodeURIComponent(id)}`}
                                  style={{ color: "var(--wp-text, #fff)", textDecoration: "none", fontWeight: 600 }}
                                >
                                  {value}
                                </Link>
                              </td>
                            );
                          }
                          return (
                            <td
                              key={ci}
                              style={{ padding: "10px 12px", fontSize: 13, color: "var(--wp-text-dim, #a0a8b4)" }}
                            >
                              {value}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div style={{ padding: 12, textAlign: "center" }}>
              <button
                type="button"
                disabled={loadingMore}
                onClick={() =>
                  void fetchPage({
                    q: query,
                    stagesCSV: selectedStages.join(","),
                    offset: records.length,
                    append: true,
                  })
                }
                style={linkBtnStyle}
                data-testid="sf-list-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {createOpen && (
        <SalesforceCreateModal
          open={true}
          type={type}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            router.push(`/portal/salesforce/${type}/${encodeURIComponent(id)}`);
          }}
        />
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface, #1c1e22)",
  border: "1px solid var(--wp-dark-border, #2a2c30)",
  borderRadius: 8,
  padding: 16,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark, #111)",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 13,
};

const linkBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--wp-dark-surface2, #16181c)",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-dark-border, #2a2c30)",
  borderRadius: 6,
  textDecoration: "none",
  fontSize: 13,
  cursor: "pointer",
  display: "inline-block",
};

const ctaLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 14px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark, #111)",
  borderRadius: 6,
  fontWeight: 600,
  textDecoration: "none",
};
