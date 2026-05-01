"use client";

/**
 * /principles/team/[userId] — leadership drill-down on a single
 * member's principle observations. 403 surface for non-leadership.
 *
 * Pure consumer of /api/principles/team/[userId].
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";

interface Subject {
  userId: string;
  displayName: string;
  email: string | null;
}
interface Principle {
  id: string;
  slug: string;
  title: string;
  domains: string[];
  scoreboardWeight: number;
}
interface Observation {
  id: string;
  principleId: string;
  surface: string;
  surfaceSubtype: string | null;
  observedAt: string;
  score: number;
  evidence: Record<string, unknown>;
}
interface TeamMemberResp {
  subject: Subject;
  principles: Principle[];
  observations: Observation[];
}

const LEADERSHIP_ROLES = new Set(["ceo", "cto"]);

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
function scoreColor(score: number) {
  if (score < -0.3) return "var(--wp-error)";
  if (score > 0.3) return "var(--wp-success)";
  return "var(--wp-warning)";
}

export default function TeamMemberPrinciplesPage() {
  const params = useParams();
  const userId = (params?.userId as string) || "";
  const me = getInstinctUser<{ id: string; role?: string; name?: string }>();
  const isLeadership = LEADERSHIP_ROLES.has((me?.role || "").toLowerCase());
  const [data, setData] = useState<TeamMemberResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/principles/team/${encodeURIComponent(userId)}`,
      );
      if (res.status === 401) {
        window.location.href = "/login?next=/principles";
        return;
      }
      if (res.status === 403) {
        setError("You don't have permission to view this page.");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`team/[userId] ${res.status}`);
      const body = (await res.json()) as TeamMemberResp;
      setData(body);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isLeadership) {
    return (
      <main
        className="px-6 py-6"
        style={{ background: "var(--wp-dark)", minHeight: "100%" }}
      >
        <p
          data-testid="team-member-403"
          role="alert"
          className="text-sm"
          style={{ color: "var(--wp-error)" }}
        >
          You don't have permission to view this page.
        </p>
      </main>
    );
  }

  if (!me) return null;

  return (
    <main
      className="px-6 py-6 space-y-6"
      style={{ background: "var(--wp-dark)", minHeight: "100%" }}
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <a
            href="/principles"
            className="text-xs"
            style={{ color: "var(--wp-text-dim)" }}
          >
            ← back to principles
          </a>
          <h1
            className="text-2xl font-bold mt-1"
            style={{ color: "var(--wp-gold)" }}
          >
            {data?.subject.displayName ?? userId}
          </h1>
          {data?.subject.email && (
            <p
              className="text-xs mt-0.5"
              style={{ color: "var(--wp-text-muted)" }}
            >
              {data.subject.email}
            </p>
          )}
          <p
            className="text-xs mt-1"
            style={{ color: "var(--wp-text-muted)" }}
          >
            Patterns are signals for a conversation, not a verdict.
          </p>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          data-testid="team-member-error"
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
        <div data-testid="team-member-loading" style={{ color: "var(--wp-text-dim)" }}>
          Loading…
        </div>
      ) : data ? (
        data.principles.map((p) => {
          const obs = data.observations.filter((o) => o.principleId === p.id);
          return (
            <article
              key={p.id}
              data-testid={`team-member-card-${p.slug}`}
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
                  weight {p.scoreboardWeight}
                </span>
              </header>
              {obs.length === 0 ? (
                <p
                  className="text-xs"
                  style={{ color: "var(--wp-text-muted)" }}
                >
                  No observations in the last 30 days.
                </p>
              ) : (
                <ul className="space-y-2">
                  {obs.map((o) => (
                    <li
                      key={o.id}
                      data-testid={`team-member-obs-${o.id}`}
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
                        {o.score.toFixed(2)}
                      </span>
                      <span className="flex-1">
                        <strong style={{ color: "var(--wp-text)" }}>
                          {o.surfaceSubtype || o.surface}
                        </strong>
                        <span
                          style={{
                            color: "var(--wp-text-muted)",
                            marginLeft: 8,
                          }}
                        >
                          {fmtDate(o.observedAt)}
                        </span>
                        {(() => {
                          const notes = (o.evidence as { notes?: unknown }).notes;
                          return typeof notes === "string" ? (
                            <span
                              className="block mt-0.5"
                              style={{ color: "var(--wp-text-muted)" }}
                            >
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
        })
      ) : null}
    </main>
  );
}
