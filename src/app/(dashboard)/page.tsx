"use client";

import { useState, useEffect, useRef } from "react";
import IntegrationStatusBanner from "@/components/IntegrationStatusBanner";
import MorningBriefing from "@/components/MorningBriefing";
import MsInsightsPanel from "@/components/MsInsightsPanel";
import Skeleton from "@/components/ui/Skeleton";
import Tooltip from "@/components/ui/Tooltip";
import { getInstinctToken, authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  FALLBACK_ACTIONS,
  type QuickAction,
} from "@/lib/insights/quick-actions";

interface DashboardData {
  shadow_mode: boolean;
  knowledge_count: number;
  discussion_count: number;
  feature_count: number;
  team_count: number;
  ai_efficiency: { zero_token_pct: number; zero_token_answers: number; ai_calls: number } | null;
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const EVENT_LABELS: Record<string, string> = {
  "knowledge.question_asked": "Asked a question",
  "knowledge.answer_found": "Found an answer",
  "knowledge.answer_not_found": "No answer found",
  "knowledge.answer_rated": "Rated an answer",
  "knowledge.doc_generated": "Generated a document",
  "feature.request_submitted": "Submitted feature request",
  "feature.request_analyzed": "Feature analyzed",
  "feature.request_approved": "Feature approved",
  "discussion.thread_created": "Created discussion",
  "discussion.reply_posted": "Replied to discussion",
  "discussion.resolved": "Resolved discussion",
  "journal.entry_created": "Wrote journal entry",
  "system.login": "Logged in",
};

interface RecentEvent {
  id: string;
  event_type: string;
  user_id: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

function getUserRole(): string | null {
  try {
    const token = getInstinctToken();
    if (!token) return null;
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || null;
  } catch {
    return null;
  }
}

interface SetupStatus {
  complete: boolean;
  steps: {
    profile: boolean;
    team: boolean;
    integrations: boolean;
  };
  nextStep: "profile" | "team" | "integrations" | "complete";
}

/**
 * Build the 3-step onboarding checklist for the dashboard banner.
 * Pure helper so it's unit-testable without rendering the page.
 *
 * Steps are intentionally ordered from "must do first" to "nice to
 * have" so the user has a clear path. Each step has a label, a CTA,
 * and the boolean from /api/workspace/status that flags completion.
 */
export interface OnboardingStep {
  key: "profile" | "integrations" | "team";
  label: string;
  description: string;
  done: boolean;
  ctaHref: string;
  ctaLabel: string;
}

export function buildOnboardingSteps(status: SetupStatus | null): OnboardingStep[] {
  const steps = status?.steps ?? { profile: false, team: false, integrations: false };
  return [
    {
      key: "profile",
      label: "Set up your workspace",
      description:
        "Tell Instinct what to call your workspace and add yourself as the first team member.",
      done: !!steps.profile,
      ctaHref: "/setup",
      ctaLabel: steps.profile ? "Edit profile" : "Set up workspace",
    },
    {
      key: "integrations",
      label: "Connect Microsoft 365",
      description:
        "Link your Outlook so Instinct can read meeting invites, emails, and Teams chats — and ingest the Porsche Academy automations.",
      done: !!steps.integrations,
      ctaHref: "/settings",
      ctaLabel: steps.integrations ? "Manage integrations" : "Connect Microsoft",
    },
    {
      key: "team",
      label: "Invite your team",
      description: "Add at least one teammate so Instinct can surface their work alongside yours.",
      done: !!steps.team,
      ctaHref: "/hr",
      ctaLabel: steps.team ? "Manage team" : "Invite team",
    },
  ];
}

// Build the immediate cold-start tile list from FALLBACK_ACTIONS so
// the card never renders empty during the first paint.
const FALLBACK_QUICK_ACTIONS: QuickAction[] = FALLBACK_ACTIONS.map((a) => ({
  label: a.label,
  href: a.href,
  score: 0,
  source: "fallback" as const,
}));

/**
 * Build the analytics payload for a Quick Action click. Pure function
 * so the UI test can assert the exact payload shape without rendering
 * the whole dashboard page.
 */
export function buildQuickActionClickPayload(
  action: QuickAction,
  position: number,
): { event: "dashboard.quick_action_clicked"; metadata: { href: string; position: number; source: "personalized" | "fallback" } } {
  return {
    event: "dashboard.quick_action_clicked",
    metadata: {
      href: action.href,
      position,
      source: action.source,
    },
  };
}

/**
 * Build the analytics payload for the once-per-mount "rendered" event.
 */
export function buildQuickActionsRenderedPayload(
  actions: QuickAction[],
): { event: "dashboard.quick_actions_rendered"; metadata: { source: "personalized" | "fallback"; action_count: number } } {
  return {
    event: "dashboard.quick_actions_rendered",
    metadata: {
      source: actions[0]?.source ?? "fallback",
      action_count: actions.length,
    },
  };
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBriefing, setShowBriefing] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupComplete, setSetupComplete] = useState(true); // default true to avoid flash
  // Personalized Quick Actions — initialised to the static fallback so the
  // tile is never empty. Replaced once /api/insights/quick-actions resolves.
  const [quickActions, setQuickActions] = useState<QuickAction[]>(FALLBACK_QUICK_ACTIONS);
  // Ref guard — fire the rendered analytics event exactly once per mount.
  // Using a ref (vs. state) avoids a setState-in-effect lint rule and a
  // cascading render that would just toggle a flag.
  const quickActionsRenderedRef = useRef(false);

  useEffect(() => {
    // Briefing available to all users; respects localStorage preference.
    // Dual-read for one release so pre-migration browsers still honor it.
    const disabled =
      (localStorage.getItem("instinct_briefing_enabled") ??
        localStorage.getItem("apex_briefing_enabled")) === "false";
    if (!disabled) {
      setShowBriefing(true);
    }
  }, []);

  useEffect(() => {
    const token = getInstinctToken();
    if (!token) {
      window.location.href = "/login?next=/";
      return;
    }

    // Track page view
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "dashboard" } }),
    }).catch(() => {});

    // Check workspace setup status
    fetchWithRefresh("/api/workspace/status", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        setSetupStatus(data);
        setSetupComplete(data.complete ?? true);
        if (!data.complete) {
          // Track banner shown
          fetchWithRefresh("/api/analytics", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ event: "system.setup_banner_shown", metadata: {} }),
          }).catch(() => {});
        }
      })
      .catch(() => {});

    fetchWithRefresh("/api/dashboard", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Fetch recent events from journal
    fetchWithRefresh("/api/journal", {
      headers: authHeaders(),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.journal?.auto_context?.events) {
          // Drop internal plumbing (ambient.*, token rotation, page views).
          // EVENT_LABELS is the allowlist of user-meaningful events.
          setEvents(
            (data.journal.auto_context.events as RecentEvent[]).filter(
              (e) => EVENT_LABELS[e.event_type],
            ),
          );
        }
      })
      .catch(() => {});

    // Personalized Quick Actions — replaces the four hard-coded tiles
    // with the user's most-used routes (decayed half-life over 30 days).
    // Falls back silently to the static four on error. Fires the
    // `dashboard.quick_actions_rendered` analytics event exactly once,
    // after we know whether we're showing personalized or fallback —
    // so click-through rate is grouped against the right cohort.
    const fireRendered = (actions: QuickAction[]) => {
      if (quickActionsRenderedRef.current) return;
      quickActionsRenderedRef.current = true;
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(buildQuickActionsRenderedPayload(actions)),
      }).catch(() => {});
    };

    fetchWithRefresh("/api/insights/quick-actions", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data: { actions?: QuickAction[] }) => {
        if (Array.isArray(data?.actions) && data.actions.length > 0) {
          setQuickActions(data.actions);
          fireRendered(data.actions);
        } else {
          fireRendered(FALLBACK_QUICK_ACTIONS);
        }
      })
      .catch(() => {
        fireRendered(FALLBACK_QUICK_ACTIONS);
      });
  }, []);

  function handleQuickActionClick(action: QuickAction, position: number) {
    // Fire-and-forget. Do NOT await — link navigation must not block.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(buildQuickActionClickPayload(action, position)),
    }).catch(() => {});
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6 wp-fade-in" data-testid="dashboard-skeleton">
        <Skeleton width={180} height={28} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <Skeleton width={140} height={20} />
            <div style={{ height: 16 }} />
            <Skeleton.Lines lines={4} />
          </div>
          <div
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <Skeleton width={140} height={20} />
            <div style={{ height: 16 }} />
            <Skeleton.Lines lines={4} />
          </div>
        </div>
      </div>
    );
  }

  const statCards: Array<{
    label: string;
    value: number;
    color: string;
    href: string;
    hint: string;
  }> = [
    {
      label: "Knowledge Entries",
      value: stats?.knowledge_count ?? 0,
      color: "var(--wp-gold)",
      href: "/knowledge",
      hint: "Click to search the knowledge base",
    },
    {
      label: "Active Discussions",
      value: stats?.discussion_count ?? 0,
      color: "var(--wp-info)",
      href: "/discussions",
      hint: "Open the discussion threads",
    },
    {
      label: "Feature Requests",
      value: stats?.feature_count ?? 0,
      color: "var(--wp-success)",
      href: "/features",
      hint: "Open the feature request board",
    },
    {
      label: "Team Members",
      value: stats?.team_count ?? 0,
      color: "var(--wp-warning)",
      href: "/hr",
      hint: "Open the team directory",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6 wp-fade-in" data-testid="dashboard-ready">
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Dashboard
      </h1>

      {/* OAuth callback status banner (Microsoft / QuickBooks) */}
      <IntegrationStatusBanner />

      {/* First-run onboarding checklist — auto-hides once every step
          flips to done. Each step has a checkmark + a CTA that takes
          the user straight to the page where they can finish it.
          Built for the non-tech-savvy: no jargon, plain-language
          descriptions, one obvious action per row. */}
      {!setupComplete && (
        <div
          data-testid="onboarding-checklist"
          style={{
            padding: "1.5rem",
            background: "var(--wp-card, var(--wp-dark-surface))",
            border: "2px solid var(--wp-gold)",
            borderRadius: "12px",
          }}
        >
          <h3 className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
            Welcome — let&apos;s get you set up
          </h3>
          <p className="text-sm mt-1 mb-4" style={{ color: "var(--wp-text-dim)" }}>
            Three quick steps and Instinct will start working in the background for you.
            Steps you&apos;ve already done show a check.
          </p>
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.6rem" }}>
            {buildOnboardingSteps(setupStatus).map((step, idx) => (
              <li
                key={step.key}
                data-testid={`onboarding-step-${step.key}`}
                data-done={step.done ? "true" : "false"}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.8rem",
                  padding: "0.8rem 1rem",
                  background: "var(--wp-dark-surface, #1a1a1a)",
                  border: `1px solid ${step.done ? "var(--wp-success, #16a34a)" : "var(--wp-dark-border, #333)"}`,
                  borderRadius: 8,
                  opacity: step.done ? 0.7 : 1,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: step.done
                      ? "var(--wp-success, #16a34a)"
                      : "var(--wp-dark-surface2, #222)",
                    color: step.done ? "var(--wp-dark, #000)" : "var(--wp-gold, #eab308)",
                    border: step.done ? "none" : "1px solid var(--wp-gold, #eab308)",
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {step.done ? "✓" : idx + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      color: "var(--wp-text, #eee)",
                      textDecoration: step.done ? "line-through" : "none",
                    }}
                  >
                    {step.label}
                  </div>
                  <div
                    className="text-sm"
                    style={{ color: "var(--wp-text-dim, #9ca3af)", marginTop: 2 }}
                  >
                    {step.description}
                  </div>
                </div>
                {!step.done && (
                  <a
                    href={step.ctaHref}
                    data-testid={`onboarding-cta-${step.key}`}
                    className="inline-block px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      background: "var(--wp-gold)",
                      color: "var(--wp-dark)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {step.ctaLabel}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Morning Briefing (CEO/CTO only) — now embeds Meeting Pre-Brief
          between Action Items and Today's Schedule. */}
      {showBriefing && <MorningBriefing />}

      {/* MS 365 Insights — patterns from calendar/email/tasks */}
      <MsInsightsPanel />

      {/* Stats — each card is a tooltip-wrapped link with hover-lift.
          Tooltip surfaces the click target so the user knows the card
          is interactive without having to discover it. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <Tooltip key={card.label} label={card.label} hint={card.hint}>
            <a
              href={card.href}
              data-testid={`stat-card-${card.href.replace(/\//g, "")}`}
              className="rounded-lg p-5 border block wp-hover-lift outline-none"
              style={{
                background: "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
                width: "100%",
                textDecoration: "none",
              }}
            >
              <p className="text-3xl font-bold" style={{ color: card.color }}>
                {card.value}
              </p>
              <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
                {card.label}
              </p>
            </a>
          </Tooltip>
        ))}
      </div>

      {/* AI Efficiency */}
      {stats?.ai_efficiency && (
        <div
          className="rounded-lg p-5 border"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
            AI Efficiency
          </h2>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-sm mb-1">
                <span style={{ color: "var(--wp-text-dim)" }}>Zero-Token Rate</span>
                <span style={{ color: "var(--wp-gold)" }}>{stats.ai_efficiency.zero_token_pct}%</span>
              </div>
              <div className="h-3 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(stats.ai_efficiency.zero_token_pct, 100)}%`,
                    background:
                      stats.ai_efficiency.zero_token_pct >= 70
                        ? "var(--wp-success)"
                        : stats.ai_efficiency.zero_token_pct >= 40
                          ? "var(--wp-warning)"
                          : "var(--wp-error)",
                  }}
                />
              </div>
            </div>
            <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              <span style={{ color: "var(--wp-success)" }}>{stats.ai_efficiency.zero_token_answers}</span> cached
              {" / "}
              <span style={{ color: "var(--wp-warning)" }}>{stats.ai_efficiency.ai_calls}</span> AI calls
            </div>
          </div>
        </div>
      )}

<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quick Actions — personalized from page-view analytics with a
            half-life of 14 days, top 4. Cold-start (insufficient history)
            falls back to the four static tiles the dashboard ships with
            so the card never looks broken to a brand-new user. */}
        <div
          className="rounded-lg p-5 border"
          data-testid="quick-actions-card"
          data-source={quickActions[0]?.source ?? "fallback"}
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {quickActions.map((action, idx) => (
              <a
                key={`${action.href}-${idx}`}
                href={action.href}
                data-testid={`quick-action-${idx}`}
                data-position={idx}
                data-source={action.source}
                data-href={action.href}
                onClick={() => handleQuickActionClick(action, idx)}
                className="flex items-center justify-between gap-2 rounded-lg p-3 border wp-hover-lift outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  textDecoration: "none",
                }}
              >
                <span className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>
                  {action.label}
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  style={{ color: "var(--wp-text-muted)", flexShrink: 0 }}
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div
          className="rounded-lg p-5 border"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Recent Activity
          </h2>
          <div className="space-y-1">
            {events.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-8 text-center gap-3"
                data-testid="recent-activity-empty"
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  style={{ color: "var(--wp-text-muted)" }}
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                  No activity yet
                </p>
                <p className="text-xs max-w-[260px]" style={{ color: "var(--wp-text-muted)" }}>
                  Ask a question or start a discussion. Anything you do shows up here so the team has context.
                </p>
              </div>
            ) : (
              events.slice(0, 8).map((event) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between gap-3 px-2 py-2 -mx-2 rounded-md transition-colors"
                  style={{
                    borderBottom: "1px solid var(--wp-dark-border)",
                    cursor: "default",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--wp-dark-surface2)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--wp-text)" }}>
                      {EVENT_LABELS[event.event_type] || event.event_type.replace(/[._]/g, " ")}
                    </p>
                    <p className="text-xs truncate" style={{ color: "var(--wp-text-muted)" }}>
                      {event.user_id}
                    </p>
                  </div>
                  <span
                    className="text-xs whitespace-nowrap"
                    style={{ color: "var(--wp-text-dim)" }}
                  >
                    {formatTimeAgo(event.timestamp)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
