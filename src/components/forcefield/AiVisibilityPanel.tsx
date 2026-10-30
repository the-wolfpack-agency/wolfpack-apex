"use client";

/**
 * AI visibility: which AI agents and search engines read a site, for what purpose,
 * which pages, how often, and whether each was really who it claimed to be.
 * Presentational only: the report comes from ai-visibility.ts (the client
 * dashboard via /api/forcefield/my-stats, our own sites via
 * /api/admin/site-analytics/ai-visibility). Renders an explicit empty state.
 */
import { GlassPanel } from "@/components/console";

type Purpose = "ai_training" | "ai_search" | "ai_assistant" | "search_engine" | "other";

export interface AiVisibilityData {
  days: number;
  byPurpose: Partial<Record<Purpose, number>>;
  agents: Array<{
    agent: string;
    vendor: string | null;
    purpose: Purpose;
    requests: number;
    verifiedRequests: number;
    impersonations: number;
    identity: "verified" | "impersonation" | "unverified";
    pages: number;
    topPages: Array<{ path: string; requests: number }>;
    daily: number[];
    lastSeen: string | null;
  }>;
}

const PURPOSE: Record<Purpose, { label: string; hint: string }> = {
  ai_training: { label: "AI training", hint: "Reads pages to train AI models" },
  ai_search: { label: "AI search answers", hint: "Reads pages to answer questions in AI search" },
  ai_assistant: { label: "AI assistants", hint: "Fetches a page because a person asked their assistant" },
  search_engine: { label: "Search engines", hint: "Indexes pages for search results" },
  other: { label: "Other agents", hint: "Identified agents with no documented purpose" },
};
const ORDER: Purpose[] = ["ai_training", "ai_search", "ai_assistant", "search_engine", "other"];
const MUTED = "var(--wp-muted, #9aa0a6)";

/** A tiny inline bar chart of requests per day (decorative; the numbers are in the row). */
function Spark({ values, testId }: { values: number[]; testId: string }) {
  const max = Math.max(1, ...values);
  return (
    <span data-testid={testId} aria-hidden className="inline-flex h-4 items-end gap-px align-middle">
      {values.map((v, i) => (
        <span key={i} style={{ width: 3, height: `${Math.max(v > 0 ? 15 : 4, (v / max) * 100)}%`, background: v > 0 ? "var(--wp-gold, #d4af37)" : "rgba(255,255,255,0.12)" }} />
      ))}
    </span>
  );
}

function identityText(a: AiVisibilityData["agents"][number]): { text: string; color: string } {
  if (a.identity === "impersonation") return { text: `Impersonated ${a.impersonations.toLocaleString()} times, never the real agent`, color: "#f87171" };
  const imp = a.impersonations > 0 ? `; ${a.impersonations.toLocaleString()} impersonations flagged` : "";
  if (a.identity === "verified") return { text: `Verified (${a.verifiedRequests.toLocaleString()} of ${a.requests.toLocaleString()} checked)${imp}`, color: a.impersonations > 0 ? "#fbbf24" : "#34d399" };
  return { text: `Not verifiable by its vendor's published ranges${imp}`, color: a.impersonations > 0 ? "#fbbf24" : MUTED };
}

export function AiVisibilityPanel({ data, testId = "ff-ai-visibility" }: { data: AiVisibilityData; testId?: string }) {
  const present = ORDER.filter((p) => (data.byPurpose[p] ?? 0) > 0 || data.agents.some((a) => a.purpose === p));
  return (
    <GlassPanel testId={testId} padded title="AI agents reading this site" subtitle={`Who read your pages in the last ${data.days} days, for what, and whether each was really who it claimed to be`}>
      {data.agents.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="mt-3 text-sm" style={{ color: MUTED }}>
          No AI agents or search engines have read this site yet. When one does, it appears here with its purpose and the pages it read.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2 text-xs" data-testid={`${testId}-purposes`}>
            {present.map((p) => (
              <span key={p} data-testid={`${testId}-purpose-${p}`} title={PURPOSE[p].hint} className="rounded-md px-2.5 py-1" style={{ background: "rgba(255,255,255,0.05)" }}>
                {PURPOSE[p].label}: <strong className="tabular-nums">{(data.byPurpose[p] ?? 0).toLocaleString()}</strong> requests
              </span>
            ))}
          </div>
          {present.map((p) => (
            <div key={p} className="mt-4">
              <h3 className="text-xs uppercase tracking-wide" style={{ color: MUTED }}>{PURPOSE[p].label}</h3>
              <ul className="mt-1 flex flex-col gap-2">
                {data.agents.filter((a) => a.purpose === p).map((a) => {
                  const id = identityText(a);
                  return (
                    <li key={a.agent} data-testid={`${testId}-agent`} data-agent={a.agent} className="rounded-md px-3 py-2 text-sm" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <strong>{a.agent}</strong>
                          {a.vendor ? <span style={{ color: MUTED }}> by {a.vendor}</span> : null}
                        </span>
                        <span className="flex items-center gap-2 tabular-nums">
                          <Spark values={a.daily} testId={`${testId}-spark`} />
                          <span>{a.requests.toLocaleString()} requests, {a.pages.toLocaleString()} pages</span>
                        </span>
                      </div>
                      <div className="mt-1 text-xs" data-testid={`${testId}-identity`} style={{ color: id.color }}>{id.text}</div>
                      {a.topPages.length > 0 ? (
                        <div className="mt-1 text-xs break-all" style={{ color: MUTED }}>
                          Most read: {a.topPages.map((t) => `${t.path} (${t.requests.toLocaleString()})`).join(", ")}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </GlassPanel>
  );
}
