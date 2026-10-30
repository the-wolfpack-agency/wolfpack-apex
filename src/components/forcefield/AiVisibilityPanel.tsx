"use client";

/**
 * AI visibility: which AI agents and search engines read a site, for what purpose,
 * which pages, how often, and whether each was really who it claimed to be.
 * Presentational only: the report comes from ai-visibility.ts (the client
 * dashboard via /api/forcefield/my-stats, our own sites via
 * /api/admin/site-analytics/ai-visibility). Renders an explicit empty state.
 */
import { useState } from "react";
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
    policyBlocked?: number;
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

/** The site's AI training crawler policy, as the panel shows and changes it. */
export interface TrainingControl {
  /** Every AI training crawler the site may turn away (agent-policy.ts). */
  choices: string[];
  blocked: string[];
  /** False: shown read-only (a viewer without the permission). */
  canEdit: boolean;
  /** Save the new block list; resolves true when it was stored. */
  save: (blocked: string[]) => Promise<boolean>;
}

function TrainingControlSection({ control, testId }: { control: TrainingControl; testId: string }) {
  const [blocked, setBlocked] = useState<string[]>(control.blocked);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const toggle = async (agent: string) => {
    if (!control.canEdit || state === "saving") return;
    const next = blocked.includes(agent) ? blocked.filter((a) => a !== agent) : [...blocked, agent].sort();
    setState("saving");
    const ok = await control.save(next).catch(() => false);
    if (ok) { setBlocked(next); setState("saved"); } else setState("error");
  };
  return (
    <div className="mt-5" data-testid={`${testId}-control`}>
      <h3 className="text-xs uppercase tracking-wide" style={{ color: MUTED }}>AI training crawlers</h3>
      <p className="mt-1 text-xs" style={{ color: MUTED }}>
        Choose which may read your pages to train AI models. Turning one away does not change how your site appears in search or in AI answers.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {control.choices.map((agent) => {
          const allowed = !blocked.includes(agent);
          return (
            <li key={agent} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm" style={{ background: "rgba(255,255,255,0.03)" }}>
              <span>{agent}</span>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  data-testid={`${testId}-allow-${agent}`}
                  checked={allowed}
                  disabled={!control.canEdit || state === "saving"}
                  onChange={() => void toggle(agent)}
                />
                <span style={{ color: allowed ? "#34d399" : "#f87171" }}>{allowed ? "Allowed" : "Turned away"}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs" role="status" data-testid={`${testId}-control-status`} style={{ color: state === "error" ? "#f87171" : MUTED }}>
        {state === "saving" ? "Saving..." : state === "saved" ? "Saved. Your site applies it within a few minutes." : state === "error" ? "Could not save. Nothing changed; try again." : control.canEdit ? "" : "Only an administrator can change this."}
      </p>
    </div>
  );
}

export function AiVisibilityPanel({ data, testId = "ff-ai-visibility", control }: { data: AiVisibilityData; testId?: string; control?: TrainingControl }) {
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
                      {(a.policyBlocked ?? 0) > 0 ? (
                        <div className="mt-1 text-xs" data-testid={`${testId}-policy-blocked`} style={{ color: "#f87171" }}>
                          Turned away by your policy: {(a.policyBlocked ?? 0).toLocaleString()} requests
                        </div>
                      ) : null}
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
      {control ? <TrainingControlSection control={control} testId={testId} /> : null}
    </GlassPanel>
  );
}
