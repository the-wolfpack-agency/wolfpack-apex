"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface Attendee {
  email: string;
}

interface Thread {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedDateTime: string;
  bodyPreview: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
}

interface LinkedGoal {
  id: string;
  title: string;
}

interface PrebriefResponse {
  meeting: {
    id: string;
    subject: string;
    start: string;
    end: string;
    location: string;
    attendees: string[];
  };
  attendeeEmails: string[];
  recentThreads: Thread[];
  openTasks: Task[];
  linkedGoal: LinkedGoal | null;
  decisionSnippet: string | null;
}

type SectionKey = "attendees" | "threads" | "tasks" | "goal" | "decision";

interface Props {
  meetingId: string;
}

function fireAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

export default function MeetingPreBrief({ meetingId }: Props) {
  const [data, setData] = useState<PrebriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    attendees: true,
    threads: true,
    tasks: true,
    goal: false,
    decision: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/prebrief/${encodeURIComponent(meetingId)}`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          setError("Meeting not found");
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError("Unable to load pre-brief");
          setLoading(false);
          return;
        }
        const json = (await res.json()) as PrebriefResponse;
        setData(json);
        setLoading(false);
        fireAnalytics("meeting.prebrief_viewed", {
          meeting_id: meetingId,
          attendee_count: json.attendeeEmails.length,
          thread_count: json.recentThreads.length,
          open_task_count: json.openTasks.length,
          has_linked_goal: json.linkedGoal !== null,
        });
      } catch {
        if (!cancelled) {
          setError("Unable to load pre-brief");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const toggle = useCallback(
    (key: SectionKey) => {
      setExpanded((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        if (next[key]) {
          fireAnalytics("meeting.prebrief_section_expanded", {
            meeting_id: meetingId,
            section: key,
          });
        }
        return next;
      });
    },
    [meetingId],
  );

  if (loading) {
    return (
      <div
        data-testid="meeting-prebrief-loading"
        style={tileStyle}
      >
        <div style={titleStyle}>Meeting pre-brief</div>
        <div style={{ color: "var(--wp-text-dim)", fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div data-testid="meeting-prebrief-error" style={tileStyle}>
        <div style={titleStyle}>Meeting pre-brief</div>
        <div
          role="alert"
          style={{ color: "var(--wp-warning)", fontSize: 13 }}
        >
          {error || "No data"}
        </div>
      </div>
    );
  }

  const { meeting, attendeeEmails, recentThreads, openTasks, linkedGoal, decisionSnippet } = data;

  return (
    <div data-testid="meeting-prebrief" style={tileStyle}>
      <header style={{ marginBottom: 12 }}>
        <div style={titleStyle}>{meeting.subject}</div>
        <div style={{ color: "var(--wp-text-dim)", fontSize: 12, marginTop: 2 }}>
          {new Date(meeting.start).toLocaleString()} · {meeting.location || "No location"}
        </div>
      </header>

      <Section
        id="attendees"
        label="Attendees"
        count={attendeeEmails.length}
        expanded={expanded.attendees}
        onToggle={() => toggle("attendees")}
      >
        <div data-testid="prebrief-attendees">
          {meeting.attendees.length === 0 ? (
            <div style={emptyStyle}>No attendees listed</div>
          ) : (
            <ul style={listStyle}>
              {meeting.attendees.map((a, i) => (
                <li key={`${a}-${i}`} style={itemStyle}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        id="threads"
        label="Recent email threads"
        count={recentThreads.length}
        expanded={expanded.threads}
        onToggle={() => toggle("threads")}
      >
        <div data-testid="prebrief-threads">
          {recentThreads.length === 0 ? (
            <div style={emptyStyle}>No recent email with attendees</div>
          ) : (
            <ul style={listStyle}>
              {recentThreads.map((t) => (
                <li key={t.id} style={itemStyle}>
                  <div style={{ fontWeight: 600 }}>{t.subject}</div>
                  <div style={{ fontSize: 12, color: "var(--wp-text-dim)" }}>
                    {t.from} · {new Date(t.receivedDateTime).toLocaleDateString()}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2 }}>{t.bodyPreview}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        id="tasks"
        label="Your open tasks"
        count={openTasks.length}
        expanded={expanded.tasks}
        onToggle={() => toggle("tasks")}
      >
        <div data-testid="prebrief-tasks">
          {openTasks.length === 0 ? (
            <div style={emptyStyle}>No open tasks</div>
          ) : (
            <ul style={listStyle}>
              {openTasks.map((t) => (
                <li key={t.id} style={itemStyle}>
                  <div>{t.title}</div>
                  <div style={{ fontSize: 12, color: "var(--wp-text-dim)" }}>
                    {t.status}
                    {t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString()}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      {linkedGoal ? (
        <Section
          id="goal"
          label="Linked goal"
          count={1}
          expanded={expanded.goal}
          onToggle={() => toggle("goal")}
        >
          <div data-testid="prebrief-goal" style={itemStyle}>
            {linkedGoal.title}
          </div>
        </Section>
      ) : null}

      {decisionSnippet ? (
        <Section
          id="decision"
          label="Most recent decision"
          count={1}
          expanded={expanded.decision}
          onToggle={() => toggle("decision")}
        >
          <div data-testid="prebrief-decision" style={itemStyle}>
            {decisionSnippet}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function Section({
  id,
  label,
  count,
  expanded,
  onToggle,
  children,
}: {
  id: SectionKey;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={`prebrief-section-${id}`} style={sectionStyle}>
      <button
        type="button"
        data-testid={`prebrief-toggle-${id}`}
        aria-expanded={expanded}
        onClick={onToggle}
        style={toggleStyle}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              transition: "transform 120ms",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              color: "var(--wp-text-dim)",
              fontSize: 10,
            }}
          >
            ▶
          </span>
          <span>{label}</span>
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text-dim)",
          }}
        >
          {count}
        </span>
      </button>
      {expanded ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </div>
  );
}

const tileStyle: React.CSSProperties = {
  padding: "1rem 1.25rem",
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-border)",
  borderRadius: 10,
  color: "var(--wp-text)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--wp-gold)",
};

const sectionStyle: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: "1px solid var(--wp-border)",
};

const toggleStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: "var(--wp-text)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  padding: "4px 0",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const itemStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--wp-text)",
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--wp-text-dim)",
};
