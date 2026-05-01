"use client";

/**
 * /principles — operating-principles dashboard.
 *
 * Two surfaces gated by role:
 *   - Member view (everyone): own observations + plain-prose principle
 *     bodies. Framed as self-improvement guidance, not enforcement.
 *   - Team view (ceo/cto only): per-member aggregate scoreboard +
 *     evidence drilldown. The 403 from /api/principles/team prevents
 *     a non-leadership user from seeing this even if they craft the
 *     URL by hand.
 *
 * Member experience deliberately omits any "leadership has visibility"
 * indicator per the agreed UX framing: principles are about doing good
 * work, not about being watched.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";

interface PrincipleSummary {
  id: string;
  slug: string;
  title: string;
  domains: string[];
  bodyMd?: string;
  scoreboardWeight?: number;
  owner?: string | null;
}

interface ObservationRow {
  id: string;
  principleId: string;
  validatorId?: string;
  surface: string;
  surfaceSubtype?: string | null;
  subjectUserId?: string | null;
  observedAt: string;
  score: number;
  evidence: Record<string, unknown>;
}

interface AggregateRow {
  principleId: string;
  subjectUserId: string | null;
  subjectName?: string | null;
  subjectEmail?: string | null;
  count: number;
  meanScore: number;
}

interface MeResponse {
  principles: PrincipleSummary[];
  observations: ObservationRow[];
  sinceISO: string;
}

interface TeamResponse extends MeResponse {
  aggregates: AggregateRow[];
}

interface WeeklyReport {
  id: string;
  weekStart: string;
  weekEnd: string;
  markdownBody: string;
  observationCount: number;
  principleCount: number;
  generatedAt: string;
}

const LEADERSHIP_ROLES = new Set(["ceo", "cto"]);

function isLeadership(role: string | undefined): boolean {
  return LEADERSHIP_ROLES.has((role || "").toLowerCase());
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function scoreColor(score: number): string {
  if (score < -0.3) return "var(--wp-error)";
  if (score > 0.3) return "var(--wp-success)";
  return "var(--wp-warning)";
}

function scoreLabel(score: number): string {
  if (score < -0.3) return "drift";
  if (score > 0.3) return "adherence";
  return "neutral";
}

export default function PrinciplesPage() {
  const user = getInstinctUser<{ id: string; role?: string; name?: string }>();
  const showTeamTab = isLeadership(user?.role);
  const [tab, setTab] = useState<"me" | "team">("me");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [config, setConfig] = useState<{
    docUrl: string | null;
    ownerUserId: string | null;
    effective: { ownerUserId: string; ownerAutoDetected: boolean } | null;
  } | null>(null);
  const [configDocUrl, setConfigDocUrl] = useState<string>("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [editingUrl, setEditingUrl] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const meRes = await fetchWithRefresh("/api/principles/me");
      if (meRes.status === 401) {
        window.location.href = "/login?next=/principles";
        return;
      }
      if (!meRes.ok) throw new Error(`me ${meRes.status}`);
      const meData = (await meRes.json()) as MeResponse;
      setMe(meData);

      if (showTeamTab) {
        const teamRes = await fetchWithRefresh("/api/principles/team");
        if (teamRes.ok) {
          const teamData = (await teamRes.json()) as TeamResponse;
          setTeam(teamData);
        }
        const reportRes = await fetchWithRefresh(
          "/api/principles/reports/latest",
        );
        if (reportRes.ok) {
          const rj = (await reportRes.json()) as { report: WeeklyReport | null };
          setReport(rj.report);
        }
        const cfgRes = await fetchWithRefresh("/api/principles/config");
        if (cfgRes.ok) {
          const cfg = (await cfgRes.json()) as {
            docUrl: string | null;
            ownerUserId: string | null;
            effective: { ownerUserId: string; ownerAutoDetected: boolean } | null;
          };
          setConfig(cfg);
          setConfigDocUrl(cfg.docUrl || "");
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [showTeamTab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfig() {
    setSavingConfig(true);
    setSyncResult(null);
    try {
      const res = await fetchWithRefresh("/api/principles/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docUrl: configDocUrl }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSyncResult(`Save failed: ${err.error || res.status}`);
      } else {
        setSyncResult("Saved.");
        await load();
      }
    } catch (e) {
      setSyncResult(`Save failed: ${(e as Error).message}`);
    }
    setSavingConfig(false);
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetchWithRefresh("/api/principles/sync-now", {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (body?.ok) {
        if (body.unchanged) {
          setSyncResult("Doc unchanged since last sync.");
        } else {
          setSyncResult(
            `Synced — ${body.inserted?.length ?? 0} principle(s) added/updated.`,
          );
        }
        await load();
      } else {
        setSyncResult(
          `Sync failed: ${body?.message || body?.code || res.status}`,
        );
      }
    } catch (e) {
      setSyncResult(`Sync failed: ${(e as Error).message}`);
    }
    setSyncing(false);
  }

  if (!user) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--wp-dark)" }}
      >
        <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>
      </div>
    );
  }

  return (
    <main
      className="px-6 py-6 space-y-6"
      style={{ background: "var(--wp-dark)", minHeight: "100%" }}
    >
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--wp-gold)" }}
          >
            Principles
          </h1>
          <p
            className="text-xs mt-1"
            style={{ color: "var(--wp-text-muted)" }}
          >
            Wolfpack operating principles. Suggestions and patterns to help you do
            your best work — synced from the canonical SharePoint doc.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          data-testid="principles-refresh"
          className="px-3 py-1.5 rounded text-xs"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-dark-border)",
          }}
        >
          Refresh
        </button>
      </header>

      {showTeamTab && (
        <div
          className="flex gap-2 border-b"
          data-testid="principles-tabs"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <TabButton active={tab === "me"} onClick={() => setTab("me")} testId="tab-me">
            My principles
          </TabButton>
          <TabButton active={tab === "team"} onClick={() => setTab("team")} testId="tab-team">
            Team scoreboard
          </TabButton>
        </div>
      )}

      {error && (
        <div
          role="alert"
          data-testid="principles-error"
          className="rounded p-3 text-sm"
          style={{
            background: "rgba(239,68,68,0.12)",
            color: "var(--wp-error)",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="principles-loading" style={{ color: "var(--wp-text-dim)" }}>
          Loading…
        </div>
      ) : tab === "me" ? (
        <MeView data={me} />
      ) : (
        <>
          {/* SharePoint connection: collapsed-by-default once configured.
              Set-and-forget — only leadership ever sees this section. */}
          <section
            data-testid="principles-setup"
            className="rounded border p-3 space-y-2"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            {config?.docUrl && !editingUrl ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span
                    className="px-2 py-0.5 rounded font-medium"
                    style={{
                      background: "rgba(34,197,94,0.15)",
                      color: "var(--wp-success)",
                    }}
                  >
                    Connected
                  </span>
                  <span style={{ color: "var(--wp-text-muted)" }}>
                    SharePoint doc · auto-syncs every 2h
                  </span>
                  {config.effective?.ownerAutoDetected && (
                    <span style={{ color: "var(--wp-text-muted)" }}>
                      · auto-detected leadership token
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="principles-sync-now"
                    disabled={syncing}
                    onClick={() => void syncNow()}
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={{
                      background: "var(--wp-gold)",
                      color: "var(--wp-dark)",
                      opacity: syncing ? 0.5 : 1,
                    }}
                  >
                    {syncing ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    type="button"
                    data-testid="principles-config-edit"
                    onClick={() => setEditingUrl(true)}
                    className="px-3 py-1.5 rounded text-xs"
                    style={{
                      background: "transparent",
                      color: "var(--wp-text-dim)",
                      border: "1px solid var(--wp-dark-border)",
                    }}
                  >
                    Edit URL
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h2
                  className="text-sm font-semibold"
                  style={{ color: "var(--wp-gold)" }}
                >
                  {config?.docUrl ? "Edit SharePoint URL" : "Connect SharePoint doc"}
                </h2>
                <p
                  className="text-xs"
                  style={{ color: "var(--wp-text-muted)" }}
                >
                  One-time setup. Paste the SharePoint URL of the operating-principles
                  doc and click Save. Background re-sync runs every 2h. Other team
                  members never need to touch this.
                </p>
                <input
                  type="url"
                  data-testid="principles-config-url"
                  value={configDocUrl}
                  onChange={(e) => setConfigDocUrl(e.target.value)}
                  placeholder="https://yourtenant.sharepoint.com/..."
                  className="w-full px-3 py-2 text-sm rounded border"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                />
                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    data-testid="principles-config-save"
                    disabled={savingConfig}
                    onClick={async () => {
                      await saveConfig();
                      setEditingUrl(false);
                    }}
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={{
                      background: "var(--wp-gold)",
                      color: "var(--wp-dark)",
                    }}
                  >
                    {savingConfig ? "Saving…" : "Save URL"}
                  </button>
                  {config?.docUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfigDocUrl(config.docUrl || "");
                        setEditingUrl(false);
                      }}
                      className="px-3 py-1.5 rounded text-xs"
                      style={{
                        background: "transparent",
                        color: "var(--wp-text-dim)",
                        border: "1px solid var(--wp-dark-border)",
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
            {syncResult && (
              <p
                data-testid="principles-sync-result"
                className="text-xs"
                style={{ color: "var(--wp-text-dim)" }}
              >
                {syncResult}
              </p>
            )}
          </section>
          {report && (
            <details
              data-testid="principles-weekly-report"
              className="rounded border p-3"
              style={{
                background: "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
              }}
            >
              <summary
                className="text-sm font-medium cursor-pointer"
                style={{ color: "var(--wp-gold)" }}
              >
                Weekly report — {report.weekStart} → {report.weekEnd} ·{" "}
                {report.observationCount} observation
                {report.observationCount === 1 ? "" : "s"}
              </summary>
              <pre
                className="text-xs whitespace-pre-wrap mt-3"
                style={{
                  color: "var(--wp-text-dim)",
                  fontFamily: "inherit",
                }}
              >
                {report.markdownBody}
              </pre>
            </details>
          )}
          <TeamView data={team} userId={user.id} />
        </>
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="px-3 py-2 text-sm transition-colors"
      style={{
        color: active ? "var(--wp-gold)" : "var(--wp-text-dim)",
        borderBottom: active
          ? "2px solid var(--wp-gold)"
          : "2px solid transparent",
        marginBottom: "-1px",
      }}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Member view                                                         */
/* ------------------------------------------------------------------ */

function MeView({ data }: { data: MeResponse | null }) {
  if (!data) {
    return (
      <div data-testid="principles-me-empty" style={{ color: "var(--wp-text-muted)" }}>
        No data yet.
      </div>
    );
  }

  const obsByPrinciple = useMemo(() => {
    const map = new Map<string, ObservationRow[]>();
    for (const o of data.observations) {
      const list = map.get(o.principleId) ?? [];
      list.push(o);
      map.set(o.principleId, list);
    }
    return map;
  }, [data.observations]);

  if (data.principles.length === 0) {
    return (
      <div data-testid="principles-me-no-principles" style={{ color: "var(--wp-text-muted)" }}>
        No principles loaded yet. Once they sync from SharePoint, your observations
        will appear here.
      </div>
    );
  }

  return (
    <div data-testid="principles-me-view" className="space-y-4">
      {data.principles.map((p) => {
        const obs = obsByPrinciple.get(p.id) ?? [];
        return (
          <article
            key={p.id}
            data-testid={`principle-card-${p.slug}`}
            className="rounded border p-4 space-y-3"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <header className="flex items-center justify-between gap-2 flex-wrap">
              <h2
                className="text-lg font-semibold"
                style={{ color: "var(--wp-text)" }}
              >
                {p.title}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {p.domains.map((d) => (
                  <span
                    key={d}
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      color: "var(--wp-text-dim)",
                    }}
                  >
                    {d}
                  </span>
                ))}
              </div>
            </header>
            {p.bodyMd ? (
              <pre
                className="text-sm whitespace-pre-wrap"
                style={{
                  fontFamily: "inherit",
                  color: "var(--wp-text-dim)",
                }}
              >
                {p.bodyMd}
              </pre>
            ) : null}
            <div
              className="text-xs"
              style={{ color: "var(--wp-text-muted)" }}
            >
              {obs.length === 0
                ? "No observations in the last week — keep it up."
                : `${obs.length} observation${obs.length === 1 ? "" : "s"} in the last week:`}
            </div>
            {obs.length > 0 && (
              <ul className="space-y-2">
                {obs.slice(0, 10).map((o) => (
                  <li
                    key={o.id}
                    data-testid={`me-observation-${o.id}`}
                    className="text-xs flex items-start gap-3 rounded p-2"
                    style={{
                      background: "var(--wp-dark)",
                      color: "var(--wp-text-dim)",
                    }}
                  >
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: scoreColor(o.score) + "22",
                        color: scoreColor(o.score),
                      }}
                    >
                      {scoreLabel(o.score)}
                    </span>
                    <span className="flex-1">
                      <strong style={{ color: "var(--wp-text)" }}>
                        {o.surfaceSubtype || o.surface}
                      </strong>
                      <span style={{ color: "var(--wp-text-muted)", marginLeft: 8 }}>
                        {formatDate(o.observedAt)}
                      </span>
                      {(() => {
                        const notes = (o.evidence as { notes?: unknown }).notes;
                        return typeof notes === "string" ? (
                          <span className="block mt-0.5" style={{ color: "var(--wp-text-muted)" }}>
                            {notes}
                          </span>
                        ) : null;
                      })()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Team view (leadership only)                                         */
/* ------------------------------------------------------------------ */

function TeamView({
  data,
  userId,
}: {
  data: TeamResponse | null;
  userId: string;
}) {
  if (!data) {
    return (
      <div data-testid="principles-team-empty" style={{ color: "var(--wp-text-muted)" }}>
        Team data unavailable.
      </div>
    );
  }
  const aggByPrinciple = useMemo(() => {
    const map = new Map<string, AggregateRow[]>();
    for (const a of data.aggregates) {
      const list = map.get(a.principleId) ?? [];
      list.push(a);
      map.set(a.principleId, list);
    }
    /* Sort each principle's rows by lowest mean (most drift) first. */
    for (const [, list] of map) {
      list.sort((a, b) => a.meanScore - b.meanScore);
    }
    return map;
  }, [data.aggregates]);

  if (data.principles.length === 0) {
    return (
      <div data-testid="principles-team-no-principles" style={{ color: "var(--wp-text-muted)" }}>
        No principles loaded yet.
      </div>
    );
  }

  return (
    <div data-testid="principles-team-view" className="space-y-4">
      <div
        className="rounded p-3 text-xs"
        style={{
          background: "var(--wp-dark-surface)",
          color: "var(--wp-text-muted)",
          border: "1px solid var(--wp-dark-border)",
        }}
      >
        Aggregate view: counts and mean scores per (principle × team member). Use
        sparingly — patterns are signals for a conversation, not a verdict.
      </div>
      {data.principles.map((p) => {
        const rows = aggByPrinciple.get(p.id) ?? [];
        return (
          <article
            key={p.id}
            data-testid={`team-card-${p.slug}`}
            className="rounded border p-4 space-y-3"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <header className="flex items-center justify-between gap-2 flex-wrap">
              <h2
                className="text-lg font-semibold"
                style={{ color: "var(--wp-text)" }}
              >
                {p.title}
              </h2>
              <span
                className="text-xs"
                style={{ color: "var(--wp-text-muted)" }}
              >
                weight {p.scoreboardWeight ?? 1}
                {p.owner ? ` · ${p.owner}` : ""}
              </span>
            </header>
            {rows.length === 0 ? (
              <p
                className="text-xs"
                style={{ color: "var(--wp-text-muted)" }}
              >
                No observations yet.
              </p>
            ) : (
              <table
                className="w-full text-xs"
                data-testid={`team-aggregates-${p.slug}`}
              >
                <thead>
                  <tr style={{ color: "var(--wp-text-muted)" }}>
                    <th className="text-left py-1">Member</th>
                    <th className="text-right py-1">Count</th>
                    <th className="text-right py-1">Mean score</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.principleId}::${r.subjectUserId ?? "team"}`}
                      data-testid={`team-row-${p.slug}-${r.subjectUserId ?? "team"}`}
                      style={{
                        borderTop: "1px solid var(--wp-dark-border)",
                      }}
                    >
                      <td className="py-1.5" style={{ color: "var(--wp-text)" }}>
                        {r.subjectUserId === null
                          ? "(team-wide)"
                          : r.subjectUserId === userId
                            ? `${r.subjectName || r.subjectUserId} (you)`
                            : r.subjectName || r.subjectUserId}
                        {r.subjectUserId ? (
                          <a
                            href={`/principles/team/${encodeURIComponent(r.subjectUserId)}`}
                            className="ml-2 text-xs"
                            style={{ color: "var(--wp-gold)" }}
                          >
                            view
                          </a>
                        ) : null}
                      </td>
                      <td className="py-1.5 text-right" style={{ color: "var(--wp-text-dim)" }}>
                        {r.count}
                      </td>
                      <td
                        className="py-1.5 text-right font-medium"
                        style={{ color: scoreColor(r.meanScore) }}
                      >
                        {r.meanScore.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        );
      })}
    </div>
  );
}
