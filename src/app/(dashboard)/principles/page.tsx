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
  /** Count of team-wide rows for this principle (subject_user_id IS
   *  NULL). Used to swap the My-principles empty-state copy from
   *  "nothing happened" to "all activity is team-wide — see Team
   *  scoreboard" when relevant. */
  teamWideObservationCount?: number;
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

/* Subtypes that emit ONE observation per Dallas day / window (rollups
   with snapToOrgDay observed_at). For these, only the calendar date
   carries meaning — showing "8:00 PM" in the UI mis-suggests an event
   happened at 8 PM when really the row covers the whole day. */
const ROLLUP_SUBTYPES = new Set<string>([
  "focus_block_ratio",
  "weekly_priority_count",
  "weekly_finish_rate",
  "meeting_density",
  "declined_attendance_rate",
  "kr_friday_status",
  "okr_measurable",
]);

function formatObservedAt(iso: string, subtype?: string | null): string {
  try {
    if (subtype && ROLLUP_SUBTYPES.has(subtype)) {
      return new Date(iso).toLocaleDateString();
    }
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function scoreColor(score: number): string {
  if (score <= -0.3) return "var(--wp-error)";
  if (score >= 0.3) return "var(--wp-success)";
  return "var(--wp-warning)";
}

function scoreLabel(score: number): string {
  if (score <= -0.3) return "drift";
  if (score >= 0.3) return "adherence";
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
  const [evaluatingAll, setEvaluatingAll] = useState(false);
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

  async function evaluateAll() {
    setEvaluatingAll(true);
    setSyncResult(null);
    try {
      const res = await fetchWithRefresh("/api/principles/evaluate-all", {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (body?.ok) {
        setSyncResult(
          `Evaluated ${body.principles ?? 0} principle(s) — ${body.observations ?? 0} observation(s) recorded.`,
        );
        await load();
      } else {
        setSyncResult(
          `Evaluate failed: ${body?.error || body?.message || res.status}`,
        );
      }
    } catch (e) {
      setSyncResult(`Evaluate failed: ${(e as Error).message}`);
    }
    setEvaluatingAll(false);
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
            your best work. Edited directly in Instinct; every change is versioned
            in the audit log.
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
          {/* Native principle CRUD — primary path. */}
          <NativePrincipleManager onChange={() => void load()} />

          {/* SharePoint connection: collapsed by default; optional path
              for orgs that want to mirror an existing doc. */}
          <details
            className="rounded border"
            style={{
              background: "var(--wp-dark-surface)",
              borderColor: "var(--wp-dark-border)",
            }}
          >
            <summary
              className="text-xs px-3 py-2 cursor-pointer"
              style={{ color: "var(--wp-text-muted)" }}
            >
              Optional: import from SharePoint doc
            </summary>
            <div className="p-3 pt-0">
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
                    data-testid="principles-evaluate-all"
                    disabled={evaluatingAll}
                    onClick={() => void evaluateAll()}
                    title="Backfill observations across every active principle now (no waiting on the periodic cron)"
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      color: "var(--wp-text)",
                      border: "1px solid var(--wp-gold)",
                      opacity: evaluatingAll ? 0.5 : 1,
                    }}
                  >
                    {evaluatingAll ? "Evaluating…" : "Evaluate all"}
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
            </div>
          </details>
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
                ? (p.teamWideObservationCount ?? 0) > 0
                  ? `No personal observations — ${p.teamWideObservationCount} team-wide observation${p.teamWideObservationCount === 1 ? "" : "s"} this week (see Team scoreboard).`
                  : "No observations in the last week — keep it up."
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
                        {formatObservedAt(o.observedAt, o.surfaceSubtype)}
                      </span>
                      {(() => {
                        const ev = o.evidence as {
                          notes?: unknown;
                          metric?: { name?: unknown; value?: unknown };
                        };
                        const notes = ev.notes;
                        const metric =
                          ev.metric && typeof ev.metric === "object"
                            ? ev.metric
                            : null;
                        const metricName =
                          metric && typeof metric.name === "string"
                            ? metric.name
                            : null;
                        const metricValue =
                          metric &&
                          (typeof metric.value === "number" ||
                            typeof metric.value === "string")
                            ? metric.value
                            : null;
                        return (
                          <>
                            {typeof notes === "string" ? (
                              <span
                                className="block mt-0.5"
                                style={{ color: "var(--wp-text-muted)" }}
                              >
                                {notes}
                              </span>
                            ) : null}
                            {metricName && metricValue !== null ? (
                              <span
                                className="block mt-0.5 text-xs"
                                style={{ color: "var(--wp-text-muted)" }}
                              >
                                {metricName}: {String(metricValue)}
                              </span>
                            ) : null}
                          </>
                        );
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

/* ------------------------------------------------------------------ */
/* Native CRUD manager (leadership only)                              */
/* ------------------------------------------------------------------ */

interface PrincipleFull {
  id: string;
  slug: string;
  title: string;
  domains: string[];
  owner: string | null;
  bodyMd: string;
  scoreboardWeight: number;
  effectiveAt: string | null;
  signals: string[];
  counterSignals: string[];
}

function NativePrincipleManager({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<PrincipleFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PrincipleFull | null>(null);
  const [creating, setCreating] = useState(false);
  const [runningFor, setRunningFor] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  async function handleRunAll() {
    setRunningAll(true);
    setRunMessage(null);
    try {
      const res = await fetchWithRefresh("/api/principles/evaluate-all", {
        method: "POST",
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        principles?: number;
        observations?: number;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setRunMessage(`Failed: ${j.error || res.status}`);
      } else {
        setRunMessage(
          `Evaluated ${j.principles ?? 0} principle(s) — ${j.observations ?? 0} observation(s) recorded.`,
        );
        onChange();
        await reload();
      }
    } catch (e) {
      setRunMessage(`Failed: ${(e as Error).message}`);
    }
    setRunningAll(false);
  }

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/principles/me?full=1");
      if (!res.ok) throw new Error(`load ${res.status}`);
      const j = (await res.json()) as { principles: PrincipleFull[] };
      setItems(j.principles || []);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleRunNow(p: PrincipleFull) {
    setRunningFor(p.id);
    setRunMessage(null);
    try {
      const res = await fetchWithRefresh(
        `/api/principles/${encodeURIComponent(p.id)}/evaluate`,
        { method: "POST" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        observations?: number;
        users?: number;
        bindings?: number;
        skippedReason?: string;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setRunMessage(`Failed: ${j.error || res.status}`);
      } else if (j.skippedReason === "no_bindings") {
        setRunMessage(
          `No signals matched a validator. Add signals like "after-hours mail" or "PR cycle time" so the system can score this principle.`,
        );
      } else if (j.skippedReason === "no_connected_users") {
        setRunMessage(
          `No team members have connected Microsoft 365 yet. Have them connect from Settings.`,
        );
      } else {
        setRunMessage(
          `Recorded ${j.observations ?? 0} observation(s) across ${j.users ?? 0} member(s).`,
        );
      }
      onChange();
    } catch (e) {
      setRunMessage(`Failed: ${(e as Error).message}`);
    }
    setRunningFor(null);
  }

  async function handleRetire(p: PrincipleFull) {
    if (!confirm(`Retire "${p.title}"? Existing observations stay for history.`)) return;
    const res = await fetchWithRefresh(
      `/api/principles/${encodeURIComponent(p.id)}/retire`,
      { method: "POST" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Retire failed: ${err.error || res.status}`);
      return;
    }
    await reload();
    onChange();
  }

  if (loading) {
    return (
      <div data-testid="principles-native-loading" style={{ color: "var(--wp-text-dim)" }}>
        Loading principles…
      </div>
    );
  }

  if (editing || creating) {
    return (
      <PrincipleForm
        initial={editing}
        onCancel={() => {
          setEditing(null);
          setCreating(false);
        }}
        onSaved={async () => {
          setEditing(null);
          setCreating(false);
          await reload();
          onChange();
        }}
      />
    );
  }

  return (
    <section
      data-testid="principles-native-manager"
      className="rounded border p-3 space-y-3"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--wp-text)" }}>
            Manage principles
          </h2>
          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            Edit principles directly. Changes are versioned in the audit log.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="principle-run-all"
            disabled={runningAll}
            onClick={() => void handleRunAll()}
            title="Evaluate every active principle now (no per-principle clicking)"
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-gold)",
              opacity: runningAll ? 0.5 : 1,
            }}
          >
            {runningAll ? "Running all…" : "Run all"}
          </button>
          <button
            type="button"
            data-testid="principle-new"
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
            }}
          >
            + New principle
          </button>
        </div>
      </div>
      {error && (
        <div
          data-testid="principles-native-error"
          className="text-xs"
          style={{ color: "var(--wp-error)" }}
        >
          {error}
        </div>
      )}
      {runMessage && (
        <div
          data-testid="principles-run-message"
          className="text-xs"
          style={{ color: "var(--wp-text-muted)" }}
        >
          {runMessage}
        </div>
      )}
      {items.length === 0 ? (
        <div
          data-testid="principles-native-empty"
          className="text-xs py-3"
          style={{ color: "var(--wp-text-muted)" }}
        >
          No principles yet. Click + New principle to add the first one.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((p) => (
            <li
              key={p.id}
              data-testid={`principle-row-${p.slug}`}
              className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs"
              style={{ background: "var(--wp-dark)" }}
            >
              <span className="flex-1 truncate">
                <strong style={{ color: "var(--wp-text)" }}>{p.title}</strong>
                <span className="ml-2" style={{ color: "var(--wp-text-muted)" }}>
                  {p.domains.join(", ") || "no domains"}
                  {p.owner ? ` · ${p.owner}` : ""}
                </span>
              </span>
              <button
                type="button"
                data-testid={`principle-run-${p.slug}`}
                onClick={() => void handleRunNow(p)}
                disabled={runningFor === p.id}
                title="Evaluate this principle across the org now"
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: "var(--wp-gold)",
                  color: "var(--wp-dark)",
                  border: "1px solid var(--wp-gold)",
                  opacity: runningFor === p.id ? 0.6 : 1,
                }}
              >
                {runningFor === p.id ? "Running…" : "Run now"}
              </button>
              <button
                type="button"
                data-testid={`principle-edit-${p.slug}`}
                onClick={() => setEditing(p)}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: "var(--wp-dark-surface2)",
                  color: "var(--wp-text)",
                  border: "1px solid var(--wp-dark-border)",
                }}
              >
                Edit
              </button>
              <button
                type="button"
                data-testid={`principle-retire-${p.slug}`}
                onClick={() => void handleRetire(p)}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: "transparent",
                  color: "var(--wp-text-muted)",
                  border: "1px solid var(--wp-dark-border)",
                }}
              >
                Retire
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PrincipleForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: PrincipleFull | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title || "");
  const [domains, setDomains] = useState((initial?.domains || []).join(", "));
  const [owner, setOwner] = useState(initial?.owner || "");
  const [bodyMd, setBodyMd] = useState(initial?.bodyMd || "");
  const [weight, setWeight] = useState(String(initial?.scoreboardWeight ?? 1));
  const [effectiveAt, setEffectiveAt] = useState(
    initial?.effectiveAt ? initial.effectiveAt.slice(0, 10) : "",
  );
  const [signals, setSignals] = useState((initial?.signals || []).join("\n"));
  const [counterSignals, setCounterSignals] = useState(
    (initial?.counterSignals || []).join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function splitLines(v: string): string[] {
    return v
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  function splitCsv(v: string): string[] {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleSave() {
    setSaving(true);
    setErr(null);
    const payload: Record<string, unknown> = {
      title: title.trim(),
      domains: splitCsv(domains),
      owner: owner.trim() || null,
      bodyMd,
      scoreboardWeight: Number(weight) || 1,
      effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : null,
      signals: splitLines(signals),
      counterSignals: splitLines(counterSignals),
    };
    const url = isEdit
      ? `/api/principles/${encodeURIComponent(initial!.id)}`
      : "/api/principles";
    const method = isEdit ? "PATCH" : "POST";
    try {
      const res = await fetchWithRefresh(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `${method} ${res.status}`);
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
    setSaving(false);
  }

  const inputStyle = {
    background: "var(--wp-dark)",
    color: "var(--wp-text)",
    border: "1px solid var(--wp-dark-border)",
  } as const;

  return (
    <section
      data-testid="principle-form"
      className="rounded border p-4 space-y-3"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--wp-text)" }}>
        {isEdit ? "Edit principle" : "New principle"}
      </h2>
      <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
        Title
        <input
          data-testid="principle-form-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
          style={inputStyle}
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Domains (comma-separated, e.g. mail, calendar)
          <input
            data-testid="principle-form-domains"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Owner (name, optional)
          <input
            data-testid="principle-form-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Scoreboard weight
          <input
            data-testid="principle-form-weight"
            type="number"
            step="0.1"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Effective from (optional)
          <input
            data-testid="principle-form-effective"
            type="date"
            value={effectiveAt}
            onChange={(e) => setEffectiveAt(e.target.value)}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
      </div>
      <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
        Body (markdown — what the principle means in practice)
        <textarea
          data-testid="principle-form-body"
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          rows={6}
          className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
          style={inputStyle}
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Signals (one per line — adherence patterns)
          <textarea
            data-testid="principle-form-signals"
            value={signals}
            onChange={(e) => setSignals(e.target.value)}
            rows={4}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
        <label className="block text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Counter-signals (one per line — drift patterns)
          <textarea
            data-testid="principle-form-counter"
            value={counterSignals}
            onChange={(e) => setCounterSignals(e.target.value)}
            rows={4}
            className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
            style={inputStyle}
          />
        </label>
      </div>
      {err && (
        <div
          data-testid="principle-form-error"
          className="text-xs"
          style={{ color: "var(--wp-error)" }}
        >
          {err}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          data-testid="principle-form-cancel"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded text-xs"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-dark-border)",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="principle-form-save"
          onClick={() => void handleSave()}
          disabled={saving || !title.trim()}
          className="px-3 py-1.5 rounded text-xs font-medium"
          style={{
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            opacity: saving || !title.trim() ? 0.5 : 1,
          }}
        >
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
        </button>
      </div>
    </section>
  );
}
